import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageSEO } from "@/lib/seo";
import { useWS } from "@/lib/ws-context";
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import type { AgentWithSignalAgent } from "@shared/schema";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { waitForFinalized } from "@/lib/tx-verify";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Bot,
  Plus,
  Play,
  Square,
  Activity,
  Shield,
  Zap,
  Wallet,
  Copy,
  CheckCircle,
  ArrowRight,
  Info,
  Coins,
  AlertTriangle,
  Radio,
  Signal,
  PlugZap,
  Trash2,
  TrendingUp,
  ArrowDownRight,
  Package,
  Clock,
  CheckCircle2,
  XOctagon,
  Pencil,
  Loader2,
  Fuel,
  Eye,
} from "lucide-react";
import type { InstructionBundleRecord } from "@shared/schema";

function LeverageRiskPanel({ leverage, slBps, minColl, maxColl }: { leverage: number; slBps?: number; minColl?: number; maxColl?: number }) {
  const liqDistPct = +(100 / leverage).toFixed(2);
  const effSlPct = +(4 / leverage).toFixed(3);
  const effSlBps = Math.round(effSlPct * 100);
  const isSlCapped = slBps !== undefined && slBps > effSlBps;

  const tier = leverage <= 10 ? "conservative"
    : leverage <= 20 ? "moderate"
    : leverage <= 35 ? "high"
    : "extreme";

  const tierConfig = {
    conservative: { label: "Conservative", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-400" },
    moderate:     { label: "Moderate",     color: "text-blue-400",    bg: "bg-blue-500/10 border-blue-500/20",     dot: "bg-blue-400" },
    high:         { label: "High Risk",    color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/20",   dot: "bg-amber-400" },
    extreme:      { label: "Extreme Risk", color: "text-red-400",     bg: "bg-red-500/10 border-red-500/20",       dot: "bg-red-400" },
  }[tier];

  const recSl = tier === "conservative" ? "100–200 bps (1–2%)"
    : tier === "moderate" ? "50–100 bps (0.5–1%)"
    : tier === "high" ? "25–50 bps (0.25–0.5%)"
    : "10–25 bps (0.1–0.25%)";

  const recTp = tier === "conservative" ? "200–400 bps (2–4%)"
    : tier === "moderate" ? "100–200 bps (1–2%)"
    : tier === "high" ? "50–150 bps (0.5–1.5%)"
    : "25–75 bps (0.25–0.75%)";

  const recMinColl = tier === "conservative" ? "0.5–2 SUI"
    : tier === "moderate" ? "2–5 SUI"
    : tier === "high" ? "3–6 SUI"
    : "5–10 SUI";

  return (
    <div className={`rounded-md border p-3 space-y-2 text-xs ${tierConfig.bg}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${tierConfig.dot}`} />
          <span className={`font-semibold ${tierConfig.color}`}>{tierConfig.label}</span>
          <span className="text-muted-foreground">— {leverage}x leverage</span>
        </div>
        {tier === "extreme" && <AlertTriangle className="h-3 w-3 text-red-400" />}
        {tier === "high" && <AlertTriangle className="h-3 w-3 text-amber-400" />}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
        <div>Liquidation at <span className="font-mono text-foreground">{liqDistPct}% adverse</span></div>
        <div>Eff. SL cap <span className="font-mono text-foreground">{effSlBps}bps ({effSlPct}%)</span>
          {isSlCapped && <span className="text-amber-400 ml-1">(your SL will be capped)</span>}
        </div>
      </div>
      <div className="pt-1 border-t border-white/5 space-y-0.5">
        <div className="text-muted-foreground/70 font-medium uppercase tracking-wider text-[9px]">Recommendations</div>
        <div className="grid grid-cols-1 gap-0.5">
          <div className="flex gap-1"><span className="text-muted-foreground">Collateral:</span><span className="font-mono">{minColl !== undefined && maxColl !== undefined ? `${minColl}–${maxColl} SUI configured` : recMinColl}</span></div>
          <div className="flex gap-1"><span className="text-muted-foreground">Stop Loss:</span><span className="font-mono">{recSl}</span></div>
          <div className="flex gap-1"><span className="text-muted-foreground">Take Profit:</span><span className="font-mono">{recTp}</span></div>
        </div>
      </div>
    </div>
  );
}

const deployAgentSchema = insertAgentSchema.extend({
  name: z.string().min(2, "Agent name must be at least 2 characters"),
  venue: z.enum(["typus"], { errorMap: () => ({ message: "Please select a Perps DEX venue" }) }),
  leverage: z.number().min(1).max(50),
  maxQty: z.number().min(10, "Minimum position size is 10 SUI"),
  minCollateral: z.number().min(0.2, "Minimum collateral must be at least 0.2 SUI"),
  maxCollateral: z.number().min(0.4, "Maximum collateral must be at least 0.4 SUI"),
  stopLossBps: z.number().min(10).max(500),
  takeProfitBps: z.number().min(25).max(1000).optional().nullable(),
  rewardSharePct: z.number().min(0).max(100),
  userId: z.string(),
});

type DeployAgentForm = z.infer<typeof deployAgentSchema>;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button size="icon" variant="ghost" onClick={copy} data-testid="button-copy-wallet">
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function OnChainBalance({ walletAddress, fallback }: { walletAddress: string; fallback: number }) {
  const { data } = useQuery<{ sui: number }>({
    queryKey: ["/api/balance", walletAddress],
    enabled: !!walletAddress,
    refetchInterval: 15000,
  });
  const bal = data?.sui ?? fallback;
  return <span className="font-mono font-bold">{bal.toFixed(4)} SUI</span>;
}

function BundlePipelineStatus({ agentId }: { agentId: string }) {
  const { data: bundles } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles", agentId, "latest"],
    refetchInterval: 15000,
  });

  if (!bundles || bundles.length === 0) return null;

  const recent = bundles.slice(0, 5);
  const completed = bundles.filter(b => b.status === "completed").length;
  const failed = bundles.filter(b => b.status === "failed").length;
  const pending = bundles.filter(b => b.status === "pending").length;

  return (
    <div className="bg-muted rounded-md px-3 py-2 space-y-1.5" data-testid={`bundle-pipeline-${agentId}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Package className="h-3 w-3 text-primary shrink-0" />
          <span className="text-[10px] font-medium">Execution Pipeline</span>
        </div>
        <div className="flex items-center gap-1.5">
          {pending > 0 && (
            <Badge variant="secondary" className="text-[8px] gap-0.5">
              <Clock className="h-2 w-2" /> {pending}
            </Badge>
          )}
          {completed > 0 && (
            <Badge variant="default" className="text-[8px] gap-0.5">
              <CheckCircle2 className="h-2 w-2" /> {completed}
            </Badge>
          )}
          {failed > 0 && (
            <Badge variant="destructive" className="text-[8px] gap-0.5">
              <XOctagon className="h-2 w-2" /> {failed}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {recent.map((b, i) => {
          const color = b.status === "completed" ? "bg-emerald-500" :
                        b.status === "failed" ? "bg-red-500" :
                        b.status === "expired" ? "bg-muted-foreground/50" :
                        b.status === "executing" ? "bg-blue-500 animate-pulse" :
                        "bg-yellow-500";
          return (
            <div
              key={b.id}
              className={`h-1.5 flex-1 rounded-full ${color}`}
              title={`${b.bundleId.slice(0, 8)}: ${b.status}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function FundAgentDialog({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "signing" | "verifying">("idle");
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const depositMutation = useMutation({
    mutationFn: async () => {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) throw new Error("Invalid amount");
      if (!account?.address) throw new Error("Please connect your SUI wallet first");
      if (!agent.walletAddress) throw new Error("Agent wallet address not available");

      const totalMist = BigInt(Math.floor(numAmount * 1e9));
      const feeMist = BigInt(Math.floor(numAmount * PROTOCOL_FEE_RATE * 1e9));
      const agentMist = totalMist - feeMist;

      if (agentMist <= BigInt(0)) throw new Error("Amount too small after protocol fee");

      const tx = new Transaction();

      const [agentCoin, feeCoin] = tx.splitCoins(tx.gas, [agentMist, feeMist]);

      tx.transferObjects([agentCoin], agent.walletAddress);
      tx.transferObjects([feeCoin], PROTOCOL_FEE_ADDRESS);

      setStatus("signing");

      const result = await signAndExecute({
        transaction: tx,
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction failed - no digest returned");

      setStatus("verifying");

      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Transaction did not finalize on-chain");
      }

      await apiRequest("POST", `/api/agents/${agent.id}/deposit`, {
        amount: numAmount,
        txDigest,
        sender: account.address,
      });

      return txDigest;
    },
    onSuccess: (txDigest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({
        title: "Deposit confirmed on-chain",
        description: `TX: ${txDigest.slice(0, 12)}...`,
      });
      setOpen(false);
      setAmount("");
      setStatus("idle");
    },
    onError: (error: Error) => {
      toast({ title: "Deposit failed", description: error.message, variant: "destructive" });
      setStatus("idle");
    },
  });

  const numAmount = parseFloat(amount) || 0;
  const protocolFee = numAmount * PROTOCOL_FEE_RATE;
  const netAmount = numAmount - protocolFee;
  const walletConnected = !!account?.address;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`button-fund-${agent.id}`}>
          <Coins className="h-3 w-3 mr-1" />
          Fund
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Fund Agent: {agent.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          {!walletConnected && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 flex items-center gap-2">
              <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
              <span className="text-xs text-destructive">Connect your SUI wallet to fund this agent</span>
            </div>
          )}

          <div className="bg-muted rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Agent Wallet</span>
              <div className="flex items-center gap-1">
                <span className="font-mono truncate max-w-[160px]">{agent.walletAddress}</span>
                <CopyButton text={agent.walletAddress || ""} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Current Balance</span>
              <OnChainBalance walletAddress={agent.walletAddress || ""} fallback={agent.balance} />
            </div>
            {walletConnected && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Your Wallet</span>
                <span className="font-mono truncate max-w-[160px]">{account.address.slice(0, 8)}...{account.address.slice(-6)}</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-sm font-medium">Deposit Amount (SUI)</label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
              data-testid="input-deposit-amount"
            />
          </div>

          {numAmount > 0 && (
            <div className="bg-muted rounded-md p-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Deposit</span>
                <span className="font-mono">{numAmount.toFixed(4)} SUI</span>
              </div>
              <div className="flex justify-between gap-2 text-chart-4">
                <span>Protocol Fee ({(PROTOCOL_FEE_RATE * 100).toFixed(0)}%)</span>
                <span className="font-mono">-{protocolFee.toFixed(4)} SUI</span>
              </div>
              <div className="border-t border-border pt-1.5 flex justify-between gap-2 font-bold">
                <span>Net to Agent</span>
                <span className="font-mono">{netAmount.toFixed(4)} SUI</span>
              </div>
              <div className="flex items-center gap-1 text-muted-foreground mt-1">
                <Info className="h-3 w-3 shrink-0" />
                <span className="truncate">Fee to: {PROTOCOL_FEE_ADDRESS.slice(0, 10)}...{PROTOCOL_FEE_ADDRESS.slice(-6)}</span>
              </div>
            </div>
          )}

          {numAmount > 0 && (
            <div className="bg-muted/50 rounded-md p-2 text-[10px] text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">Transaction Preview</p>
              <div className="flex items-center gap-1">
                <ArrowDownRight className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
                <span>{netAmount.toFixed(4)} SUI</span>
                <span className="font-mono truncate">{agent.walletAddress?.slice(0, 10)}...{agent.walletAddress?.slice(-4)}</span>
              </div>
              <div className="flex items-center gap-1">
                <ArrowDownRight className="h-2.5 w-2.5 text-chart-4 shrink-0" />
                <span>{protocolFee.toFixed(4)} SUI</span>
                <span className="font-mono truncate">{PROTOCOL_FEE_ADDRESS.slice(0, 10)}...{PROTOCOL_FEE_ADDRESS.slice(-4)}</span>
              </div>
              <p className="text-[9px] mt-0.5">Finality verified on SUI mainnet before success</p>
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => depositMutation.mutate()}
            disabled={depositMutation.isPending || numAmount <= 0 || !walletConnected}
            data-testid="button-confirm-deposit"
          >
            {status === "signing" ? (
              "Sign in your wallet..."
            ) : status === "verifying" ? (
              "Verifying on-chain..."
            ) : depositMutation.isPending ? (
              "Processing..."
            ) : !walletConnected ? (
              "Connect Wallet First"
            ) : (
              "Sign & Send SUI"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const GAS_TOPOFF_AMOUNT = 0.5;

function GasTopOffButton({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [status, setStatus] = useState<"idle" | "signing" | "verifying">("idle");

  const topOffMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your SUI wallet first");
      if (!agent.walletAddress) throw new Error("Agent wallet not available");

      const amountMist = BigInt(Math.floor(GAS_TOPOFF_AMOUNT * 1e9));
      const tx = new Transaction();
      const [gasCoin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([gasCoin], agent.walletAddress);

      setStatus("signing");
      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction failed");

      setStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Transaction did not finalize");
      }

      await apiRequest("POST", `/api/agents/${agent.id}/gas-topoff`, {
        amount: GAS_TOPOFF_AMOUNT,
        txDigest,
        sender: account.address,
      });
      return txDigest;
    },
    onSuccess: (txDigest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
      toast({ title: `Gas sent to ${agent.name}`, description: `${GAS_TOPOFF_AMOUNT} SUI sent. TX: ${txDigest.slice(0, 12)}...` });
      setStatus("idle");
    },
    onError: (error: Error) => {
      toast({ title: "Gas top-off failed", description: error.message, variant: "destructive" });
      setStatus("idle");
    },
  });

  const isPending = topOffMutation.isPending;

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => topOffMutation.mutate()}
      disabled={isPending || !account?.address}
      className="border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
      data-testid={`button-gas-${agent.id}`}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      ) : (
        <Fuel className="h-3 w-3 mr-1" />
      )}
      {status === "signing" ? "Sign..." : status === "verifying" ? "Verifying..." : `Gas ${GAS_TOPOFF_AMOUNT}`}
    </Button>
  );
}

function TopOffAllButton({ agents }: { agents: AgentWithSignalAgent[] }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [status, setStatus] = useState<"idle" | "signing" | "verifying">("idle");

  const { data: onChainPortfolio } = useQuery<{
    agents: Array<{ agentId: string; freeSui: number }>;
  }>({
    queryKey: ["/api/agents/on-chain-portfolio"],
    refetchInterval: 10000,
    staleTime: 8000,
  });

  const lowGasAgents = agents.filter(a => {
    if (!a.walletAddress) return false;
    const chain = onChainPortfolio?.agents?.find(c => c.agentId === a.id);
    const freeSui = chain?.freeSui ?? 0;
    return freeSui < 0.2;
  });

  const topOffAllMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your SUI wallet first");
      if (lowGasAgents.length === 0) throw new Error("No agents need gas");

      const perAgentMist = BigInt(Math.floor(GAS_TOPOFF_AMOUNT * 1e9));
      const tx = new Transaction();

      const amounts = lowGasAgents.map(() => perAgentMist);
      const coins = tx.splitCoins(tx.gas, amounts);

      lowGasAgents.forEach((agent, i) => {
        tx.transferObjects([coins[i]], agent.walletAddress!);
      });

      setStatus("signing");
      const result = await signAndExecute({ transaction: tx });
      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction failed");

      setStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") {
        throw new Error(verification.error || "Transaction did not finalize");
      }

      for (const agent of lowGasAgents) {
        try {
          await apiRequest("POST", `/api/agents/${agent.id}/gas-topoff`, {
            amount: GAS_TOPOFF_AMOUNT,
            txDigest,
            sender: account.address,
          });
        } catch {}
      }

      return { txDigest, count: lowGasAgents.length };
    },
    onSuccess: ({ txDigest, count }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
      toast({ title: `Gas sent to ${count} agents`, description: `${GAS_TOPOFF_AMOUNT} SUI each. TX: ${txDigest.slice(0, 12)}...` });
      setStatus("idle");
    },
    onError: (error: Error) => {
      toast({ title: "Top-off failed", description: error.message, variant: "destructive" });
      setStatus("idle");
    },
  });

  const totalCost = lowGasAgents.length * GAS_TOPOFF_AMOUNT;
  const isPending = topOffAllMutation.isPending;

  if (lowGasAgents.length === 0) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => topOffAllMutation.mutate()}
      disabled={isPending || !account?.address}
      className="border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
      data-testid="button-topoff-all"
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      ) : (
        <Fuel className="h-3 w-3 mr-1" />
      )}
      {status === "signing" ? "Sign in wallet..." : status === "verifying" ? "Verifying..." : `Gas Top-Off ${lowGasAgents.length} Agents (${totalCost.toFixed(1)} SUI)`}
    </Button>
  );
}

function SignalAgentBadge({ agent }: { agent: AgentWithSignalAgent }) {
  const sa = agent.signalAgent;
  if (!sa) return null;

  return (
    <div className="bg-muted rounded-md p-2.5 space-y-2" data-testid={`signal-agent-${sa.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Signal className="h-3 w-3 text-primary" />
          <span className="text-[10px] font-medium">{sa.name}</span>
        </div>
        <Badge variant={sa.status === "active" ? "default" : "secondary"} className="text-[10px]">
          {sa.status}
        </Badge>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
        <span className="font-mono">{sa.strategy}</span>
        <span>Threshold: {sa.signalThreshold}/6</span>
        <span>Signals: {sa.signalCount}</span>
      </div>
      {sa.lastSignal && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-muted-foreground">Last:</span>
          <Badge variant={sa.lastSignal.includes("long") ? "default" : sa.lastSignal.includes("short") ? "destructive" : "secondary"} className="text-[10px]">
            {sa.lastSignal.replace("_", " ")}
          </Badge>
          {sa.lastSignalScore && <span className="text-muted-foreground font-mono">{sa.lastSignalScore}</span>}
        </div>
      )}
    </div>
  );
}

function MaxQtyField({ control }: { control: any }) {
  const [rawValue, setRawValue] = useState("1");
  const [isFocused, setIsFocused] = useState(false);

  return (
    <FormField
      control={control}
      name="maxQty"
      render={({ field }) => {
        const displayValue = isFocused ? rawValue : String(field.value || 1);

        return (
          <FormItem>
            <FormLabel>Max Collateral (SUI)</FormLabel>
            <FormControl>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="10"
                value={displayValue}
                onFocus={() => {
                  setRawValue(String(field.value || 1));
                  setIsFocused(true);
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "" || /^\d*\.?\d*$/.test(val)) {
                    setRawValue(val);
                    const num = parseFloat(val);
                    field.onChange(isNaN(num) ? 0 : num);
                  }
                }}
                onBlur={() => {
                  setIsFocused(false);
                  const num = parseFloat(rawValue);
                  if (isNaN(num) || num <= 0) {
                    field.onChange(1);
                  }
                }}
                data-testid="input-max-qty"
              />
            </FormControl>
            <FormDescription>Maximum SUI collateral per trade. Position size = collateral x leverage.</FormDescription>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

const VENUE_LABELS: Record<string, { name: string; type: string; supported: boolean }> = {
  typus: { name: "Typus Perps", type: "perp", supported: true },
};

const editAgentSchema = z.object({
  leverage: z.number().min(1).max(50),
  maxQty: z.number().min(10, "Minimum position size is 10 SUI"),
  minCollateral: z.number().min(0.2, "Minimum collateral must be at least 0.2 SUI"),
  maxCollateral: z.number().min(0.4, "Maximum collateral must be at least 0.4 SUI"),
  stopLossBps: z.number().min(10).max(500),
  takeProfitBps: z.number().min(25).max(1000).optional().nullable(),
  rewardSharePct: z.number().min(0).max(100),
});

type EditAgentForm = z.infer<typeof editAgentSchema>;

function EditAgentDialog({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [open, setOpen] = useState(false);

  const form = useForm<EditAgentForm>({
    resolver: zodResolver(editAgentSchema),
    defaultValues: {
      leverage: agent.leverage,
      maxQty: agent.maxQty,
      minCollateral: agent.minCollateral ?? 0.4,
      maxCollateral: agent.maxCollateral ?? 10,
      stopLossBps: agent.stopLossBps ?? 80,
      takeProfitBps: agent.takeProfitBps ?? 200,
      rewardSharePct: agent.rewardSharePct ?? 50,
    },
  });

  const editMutation = useMutation({
    mutationFn: async (values: EditAgentForm) => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      await apiRequest("PATCH", `/api/agents/${agent.id}${walletParam}`, values);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent updated", description: `${agent.name} configuration saved.` });
      setOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update agent", description: error.message, variant: "destructive" });
    },
  });

  const isRunning = agent.status === "running";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setOpen(true)}
        disabled={isRunning || !account?.address}
        title={isRunning ? "Stop agent before editing" : !account?.address ? "Connect wallet to edit" : "Edit agent configuration"}
        data-testid={`button-edit-${agent.id}`}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            Edit {agent.name}
          </DialogTitle>
        </DialogHeader>
        {isRunning && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-muted-foreground">Stop the agent before editing its configuration.</span>
          </div>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => editMutation.mutate(v))} className="space-y-4 pt-2">
            <FormField
              control={form.control}
              name="leverage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Leverage ({field.value}x)</FormLabel>
                  <FormControl>
                    <Slider
                      min={1}
                      max={50}
                      step={1}
                      value={[field.value]}
                      onValueChange={([v]) => field.onChange(v)}
                      data-testid="slider-edit-leverage"
                    />
                  </FormControl>
                  <FormDescription>1x-50x leverage for SUI perps</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {(() => {
              const lev = form.watch("leverage");
              const sl = form.watch("stopLossBps");
              const minC = form.watch("minCollateral");
              const maxC = form.watch("maxCollateral");
              return <LeverageRiskPanel leverage={lev} slBps={sl} minColl={minC} maxColl={maxC} />;
            })()}
            <FormField
              control={form.control}
              name="maxQty"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Collateral Per Trade (SUI)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      {...field}
                      onChange={(e) => field.onChange(parseFloat(e.target.value) || 10)}
                      data-testid="input-edit-maxqty"
                    />
                  </FormControl>
                  <FormDescription>Maximum collateral allocated per trade</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="minCollateral"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Min Collateral (SUI)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        min="0.2"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value === "" ? "" : parseFloat(e.target.value))}
                        onBlur={(e) => { field.onBlur(); if (e.target.value === "" || isNaN(parseFloat(e.target.value))) field.onChange(0.4); }}
                        data-testid="input-edit-min-collateral"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxCollateral"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Collateral (SUI)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        min="0.4"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value === "" ? "" : parseFloat(e.target.value))}
                        onBlur={(e) => { field.onBlur(); if (e.target.value === "" || isNaN(parseFloat(e.target.value))) field.onChange(10); }}
                        data-testid="input-edit-max-collateral"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="stopLossBps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stop Loss ({field.value} bps = {(field.value / 100).toFixed(1)}%)</FormLabel>
                  <FormControl>
                    <Slider
                      min={10}
                      max={500}
                      step={10}
                      value={[field.value]}
                      onValueChange={([v]) => field.onChange(v)}
                      data-testid="slider-edit-stoploss"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="takeProfitBps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Take Profit ({field.value || 0} bps = {((field.value || 0) / 100).toFixed(1)}%)</FormLabel>
                  <FormControl>
                    <Slider
                      min={25}
                      max={1000}
                      step={25}
                      value={[field.value || 200]}
                      onValueChange={([v]) => field.onChange(v)}
                      data-testid="slider-edit-takeprofit"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="rewardSharePct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reward Share ({field.value}%)</FormLabel>
                  <FormControl>
                    <Slider
                      min={0}
                      max={100}
                      step={5}
                      value={[field.value]}
                      onValueChange={([v]) => field.onChange(v)}
                      data-testid="slider-edit-reward"
                    />
                  </FormControl>
                  <FormDescription>Percentage of profit directed to claimable rewards</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={editMutation.isPending || isRunning}
              data-testid="button-save-edit"
            >
              {editMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function AgentCard({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const venueInfo = VENUE_LABELS[agent.venue] || { name: "Typus Perps", type: "perp", supported: true };

  const { data: activity } = useQuery<{
    chainDerived?: { tradeCount: number; totalPnl: number; winRate: number };
    gasCosts?: number;
    portfolioValue?: number;
    onChainWalletSui?: number;
    lockedCollateral?: number;
    pendingOrderCollateral?: number;
    totalUnrealizedPnl?: number;
    positions?: Array<{ status: string; side: string; sizeSui: number; entryPrice: number; collateral: number }>;
  }>({
    queryKey: ["/api/agents", agent.id, "activity"],
    refetchInterval: 12000,
    staleTime: 10000,
  });

  const { data: onChainPortfolio } = useQuery<{
    agents: Array<{
      agentId: string;
      freeSui: number;
      totalLocked: number;
      pendingOrderCollateral: number;
      portfolioValue: number;
      totalUnrealizedPnl: number;
      netDeposited: number;
      retainedProfits: number;
      claimedRewards?: number;
    }>;
  }>({
    queryKey: ["/api/agents/on-chain-portfolio"],
    refetchInterval: 10000,
    staleTime: 8000,
  });

  const chainData = onChainPortfolio?.agents?.find(a => a.agentId === agent.id);

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const newStatus = agent.status === "running" ? "idle" : "running";
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      await apiRequest("PATCH", `/api/agents/${agent.id}${walletParam}`, { status: newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: agent.status === "running" ? "Agent stopped" : "Agent started" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ force = false }: { force?: boolean } = {}) => {
      const params = new URLSearchParams();
      if (account?.address) params.set("wallet", account.address);
      if (force) params.set("force", "true");
      await apiRequest("DELETE", `/api/agents/${agent.id}?${params.toString()}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent deleted", description: `${agent.name} has been removed` });
    },
    onError: (error: Error, variables) => {
      if (variables?.force) {
        toast({
          title: "Delete failed",
          description: error.message || "Could not delete agent. Please try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Delete failed — retrying with force delete",
        description: "Positions could not be closed on-chain. Force-deleting...",
        variant: "destructive",
      });
      deleteMutation.mutate({ force: true });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet to clone");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/clone`, {
        walletAddress: account.address,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Strategy cloned", description: `${data.agent.name} created with a new wallet` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to clone", description: error.message, variant: "destructive" });
    },
  });

  const isRunning = agent.status === "running";
  const hasFunds = agent.balance > 0;
  const lastExecMs = (agent as any).lastExecutionAt ? new Date((agent as any).lastExecutionAt).getTime() : null;
  const isAgentStale = isRunning && (!lastExecMs || lastExecMs < Date.now() - 2 * 60 * 60 * 1000);
  const staleLabel = !lastExecMs ? "no trades yet"
    : Math.floor((Date.now() - lastExecMs) / (60 * 60 * 1000)) < 1 ? "< 1h idle"
    : `${Math.floor((Date.now() - lastExecMs) / (60 * 60 * 1000))}h idle`;

  return (
    <Card data-testid={`agent-card-${agent.id}`} className={isAgentStale ? "border-amber-500/40 bg-amber-500/5" : ""}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isAgentStale ? "bg-amber-500/20" : isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4 w-4 ${isAgentStale ? "text-amber-400" : isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium truncate flex items-center gap-2">
              {agent.name}
              {isAgentStale && (
                <span className="flex items-center gap-0.5 text-[8px] text-amber-400 font-semibold bg-amber-500/15 px-1.5 py-0.5 rounded-full" data-testid={`badge-stale-${agent.id}`}>
                  <Clock className="h-2.5 w-2.5" />{staleLabel}
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <PlugZap className={`h-3 w-3 ${venueInfo.supported ? "text-emerald-500" : "text-amber-500"}`} />
              <span className="text-[10px] text-muted-foreground font-mono">{venueInfo.name}</span>
              <Badge variant={venueInfo.supported ? "default" : "secondary"} className="text-[8px] px-1 py-0">
                {venueInfo.supported ? "SDK" : "PENDING"}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {(agent as any).isClone && (
            <Badge variant="outline" className="text-[8px] border-amber-500/40 text-amber-500" data-testid={`badge-clone-${agent.id}`}>
              CLONE
            </Badge>
          )}
          <Badge
            variant={isRunning ? "default" : "secondary"}
            data-testid={`badge-status-${agent.id}`}
          >
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />}
            {agent.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-5 gap-1">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Portfolio</p>
            <p className="text-xs font-mono font-bold" data-testid={`text-portfolio-${agent.id}`}>
              {chainData?.portfolioValue !== undefined
                ? `${chainData.portfolioValue.toFixed(2)}`
                : activity?.portfolioValue !== undefined
                  ? `${activity.portfolioValue.toFixed(2)}`
                  : <OnChainBalance walletAddress={agent.walletAddress || ""} fallback={agent.balance} />}
              <span className="text-[8px] text-muted-foreground ml-0.5">SUI</span>
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-emerald-400">Free SUI</p>
            <p className="text-xs font-mono font-bold text-emerald-400" data-testid={`text-free-sui-${agent.id}`}>
              {chainData?.freeSui !== undefined
                ? chainData.freeSui.toFixed(2)
                : activity?.onChainWalletSui !== undefined
                  ? activity.onChainWalletSui.toFixed(2)
                  : "—"}
              <span className="text-[8px] text-emerald-400/60 ml-0.5">SUI</span>
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Total PnL</p>
            {(() => {
              const portfolioValue = chainData?.portfolioValue ?? 0;
              const netDeposited = chainData?.netDeposited ?? (agent.totalDeposited || 0);
              const claimedRewardsOut = chainData?.claimedRewards ?? 0;
              const totalPnl = netDeposited > 0 ? (portfolioValue + claimedRewardsOut) - netDeposited : 0;
              const unrealizedPnl = chainData?.totalUnrealizedPnl || 0;
              const openPositions = activity?.positions?.filter(p => p.status === "open") || [];
              const hasOpen = openPositions.length > 0 && Math.abs(unrealizedPnl) > 0.001;
              return (
                <div>
                  <p className={`text-xs font-mono font-bold ${totalPnl > 0 ? "text-emerald-500" : totalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`} data-testid="text-total-pnl">
                    {totalPnl === 0 ? "0.00" : `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`}
                  </p>
                  {hasOpen && (
                    <p className={`text-[8px] font-mono ${unrealizedPnl >= 0 ? "text-emerald-500/70" : "text-red-500/70"}`}>
                      {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)} open
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Trades</p>
            <p className="text-xs font-mono font-bold">{activity?.chainDerived?.tradeCount ?? agent.totalTrades}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Win</p>
            <p className="text-xs font-mono font-bold">{((activity?.chainDerived?.winRate ?? agent.winRate) * 100).toFixed(0)}%</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1">
            <Shield className="h-3 w-3" />
            <span>{agent.leverage}x</span>
          </div>
          <div className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            <span>SL:{agent.stopLossBps}bps</span>
          </div>
          {agent.takeProfitBps && (
            <div className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              <span>TP:{agent.takeProfitBps}bps</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="font-mono">{venueInfo.type.toUpperCase()}</span>
          </div>
          <div className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3" />
            <span>{agent.rewardSharePct ?? 50}% share</span>
          </div>
        </div>

        <SignalAgentBadge agent={agent} />

        {isRunning && agent.lastExecutionError && (
          <div className={`${agent.lastExecutionError.includes("GAS_BUDGET") || agent.lastExecutionError.includes("GAS_CAP") ? "bg-amber-500/10 border border-amber-500/30" : "bg-destructive/10 border border-destructive/30"} rounded-md px-3 py-2 flex items-start gap-2`} data-testid={`execution-error-${agent.id}`}>
            <AlertTriangle className={`h-3 w-3 shrink-0 mt-0.5 ${agent.lastExecutionError.includes("GAS_BUDGET") || agent.lastExecutionError.includes("GAS_CAP") ? "text-amber-500" : "text-destructive"}`} />
            <div className="text-[10px] min-w-0">
              <span className={`${agent.lastExecutionError.includes("GAS_BUDGET") || agent.lastExecutionError.includes("GAS_CAP") ? "text-amber-500" : "text-destructive"}`}>
                {agent.lastExecutionError.replace(/^GAS_BUDGET_EXHAUSTED:\s*/, "").replace(/^GAS_CAP_BREACHED:\s*/, "")}
              </span>
              {(agent as any).estimatedResumeAt && agent.lastExecutionError.includes("GAS_BUDGET") && (
                <p className="text-primary text-[9px] mt-0.5">
                  Auto-resume: {(() => {
                    const resumeAt = new Date((agent as any).estimatedResumeAt).getTime();
                    const diff = resumeAt - Date.now();
                    if (diff <= 0) return "any moment now";
                    const hours = Math.floor(diff / 3600000);
                    const mins = Math.floor((diff % 3600000) / 60000);
                    return hours > 0 ? `~${hours}h ${mins}m` : `~${mins}m`;
                  })()}
                </p>
              )}
            </div>
          </div>
        )}

        <BundlePipelineStatus agentId={agent.id} />

        {agent.walletAddress && (
          <div className="bg-muted rounded-md px-3 py-2 flex items-center gap-2">
            <Wallet className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-[10px] font-mono text-muted-foreground truncate">
              {agent.walletAddress.slice(0, 8)}...{agent.walletAddress.slice(-6)}
            </span>
            <CopyButton text={agent.walletAddress} />
          </div>
        )}

        {!hasFunds && (
          <div className="bg-chart-4/10 border border-chart-4/30 rounded-md px-3 py-2 flex items-center gap-2">
            <AlertTriangle className="h-3 w-3 text-chart-4 shrink-0" />
            <span className="text-[10px] text-chart-4">Fund this agent to start trading</span>
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <FundAgentDialog agent={agent} />
          <GasTopOffButton agent={agent} />
          <Button
            className="flex-1"
            variant={isRunning ? "destructive" : "default"}
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending || (!hasFunds && !isRunning)}
            data-testid={`button-toggle-${agent.id}`}
          >
            {isRunning ? <Square className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {isRunning ? "Stop" : "Start"}
          </Button>
          <EditAgentDialog agent={agent} />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => cloneMutation.mutate()}
            disabled={cloneMutation.isPending || !account?.address}
            title={!account?.address ? "Connect wallet to clone" : "Clone strategy with new wallet"}
            data-testid={`button-clone-${agent.id}`}
          >
            {cloneMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={deleteMutation.isPending || !account?.address}
                title={!account?.address ? "Connect wallet to delete" : "Delete agent"}
                data-testid={`button-delete-${agent.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete "{agent.name}" and all its trading history, signals, and orders.{isRunning ? " The agent will be stopped automatically." : ""} This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate({})}
                  data-testid={`button-confirm-delete-${agent.id}`}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DeployAgent() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const account = useCurrentAccount();
  const { subscribe } = useWS();

  // Streaming wallet — shared with the Agents tab via localStorage.
  const [streamWallet, setStreamWallet] = useState<string>(() => {
    try { return localStorage.getItem("bwa_stream_wallet") || ""; } catch { return ""; }
  });
  const [streamInput, setStreamInput] = useState("");

  const applyStreamWallet = () => {
    const trimmed = streamInput.trim();
    if (!trimmed || !trimmed.startsWith("0x") || trimmed.length < 60) return;
    setStreamWallet(trimmed);
    try { localStorage.setItem("bwa_stream_wallet", trimmed); } catch {}
    setStreamInput("");
  };
  const clearStreamWallet = () => {
    setStreamWallet("");
    try { localStorage.removeItem("bwa_stream_wallet"); } catch {}
  };

  const effectiveWallet = account?.address || streamWallet || null;
  const isWatchMode = !account?.address && !!streamWallet;

  useEffect(() => {
    const unsub1 = subscribe("agent:updated", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
    });
    const unsub2 = subscribe("positions:updated", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
    });
    const unsub3 = subscribe("portfolio:tick", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
    });
    const unsub4 = subscribe("agents:refresh", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [subscribe]);

  usePageSEO({
    title: "Deploy Agent",
    description: "Configure and deploy AI trading agents for SUI-USDC perpetual trading on Blue Water Agents",
  });

  const form = useForm<DeployAgentForm>({
    resolver: zodResolver(deployAgentSchema),
    defaultValues: {
      userId: "default-user",
      name: "",
      venue: "typus",
      leverage: 25,
      maxQty: 10,
      minCollateral: 0.4,
      maxCollateral: 10,
      stopLossBps: 80,
      takeProfitBps: 200,
      rewardSharePct: 50,
    },
  });

  // Use deposit-based ownership: shows agents the connected wallet (or stream wallet) has funded.
  // Sentinel prevents fetching all agents when no wallet is connected.
  const deployOwnerQuery = effectiveWallet ? `?ownerWallet=${effectiveWallet}` : "?ownerWallet=not-connected";
  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents", deployOwnerQuery],
    queryFn: async () => {
      const res = await fetch(`/api/agents${deployOwnerQuery}`, { credentials: "include" });
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (values: DeployAgentForm) => {
      const payload = { ...values };
      if (account?.address) {
        payload.userId = account.address;
      }
      await apiRequest("POST", "/api/agents", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent deployed", description: "Execution agent paired with signal sub-agent. Fund your agent wallet to start trading." });
      setOpen(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to deploy agent", description: error.message, variant: "destructive" });
    },
  });

  function onSubmit(values: DeployAgentForm) {
    createMutation.mutate(values);
  }

  // Require wallet connection (or stream wallet) before showing any agent data.
  if (!account?.address && !streamWallet) {
    return (
      <div className="p-4 md:p-6 space-y-4" data-testid="page-deploy-agent">
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
          <Shield className="w-12 h-12 text-muted-foreground/30" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Connect your wallet</p>
            <p className="text-sm text-muted-foreground max-w-xs">You need a connected wallet to deploy and manage agents. Your agents are private to your wallet address.</p>
          </div>
          <div className="w-full max-w-sm space-y-2">
            <p className="text-xs text-muted-foreground/70 font-medium uppercase tracking-wide">Or watch any wallet</p>
            <div className="flex gap-2">
              <Input
                placeholder="0x... SUI wallet address"
                value={streamInput}
                onChange={(e) => setStreamInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyStreamWallet()}
                className="text-xs font-mono"
                data-testid="input-stream-wallet-deploy"
              />
              <Button size="sm" onClick={applyStreamWallet} disabled={!streamInput.trim().startsWith("0x") || streamInput.trim().length < 60} data-testid="button-watch-wallet-deploy">
                Watch
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground/50">Read-only view. No wallet connection required.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-deploy-agent">
      {/* Watch mode banner */}
      {isWatchMode && (
        <div className="flex items-center justify-between gap-2 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <Eye className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="text-[10px] text-primary font-medium">Watch Mode — Read Only</span>
            <span className="text-[9px] font-mono text-muted-foreground truncate">{streamWallet.slice(0, 8)}…{streamWallet.slice(-6)}</span>
          </div>
          <Button size="sm" variant="ghost" className="h-6 text-[9px] px-2 text-muted-foreground hover:text-foreground shrink-0" onClick={clearStreamWallet} data-testid="button-stop-watching-deploy">
            Stop
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Deploy Agent</h2>
          <p className="text-xs text-muted-foreground">Execution + Signal agent pairs for autonomous trading</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          {!isWatchMode && (
            <DialogTrigger asChild>
              <Button data-testid="button-new-agent">
                <Plus className="h-4 w-4 mr-1" />
                New Agent
              </Button>
            </DialogTrigger>
          )}
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                Deploy New Agent
              </DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Agent Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. RESCUE Bot 1" {...field} data-testid="input-agent-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="venue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Perps DEX Venue</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-venue">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="typus">Typus Perps (SDK Ready)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>Only perpetual DEX venues with SDK integration</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="leverage"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Leverage</FormLabel>
                        <span className="text-sm font-mono text-muted-foreground">{field.value}x</span>
                      </div>
                      <FormControl>
                        <Slider
                          value={[field.value]}
                          onValueChange={(v) => field.onChange(v[0])}
                          min={1}
                          max={50}
                          step={1}
                          data-testid="slider-leverage"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {(() => {
                  const lev = form.watch("leverage");
                  const sl = form.watch("stopLossBps");
                  const minC = form.watch("minCollateral");
                  const maxC = form.watch("maxCollateral");
                  return <LeverageRiskPanel leverage={lev} slBps={sl} minColl={minC} maxColl={maxC} />;
                })()}

                <MaxQtyField control={form.control} />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="minCollateral"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Min Collateral (SUI)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="0.1"
                            min="0.2"
                            placeholder="0.4"
                            {...field}
                            onChange={(e) => field.onChange(e.target.value === "" ? "" : parseFloat(e.target.value))}
                            onBlur={(e) => { field.onBlur(); if (e.target.value === "" || isNaN(parseFloat(e.target.value))) field.onChange(0.4); }}
                            data-testid="input-min-collateral"
                          />
                        </FormControl>
                        <FormDescription>Min collateral per trade</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="maxCollateral"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Collateral (SUI)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="0.1"
                            min="0.4"
                            placeholder="10"
                            {...field}
                            onChange={(e) => field.onChange(e.target.value === "" ? "" : parseFloat(e.target.value))}
                            onBlur={(e) => { field.onBlur(); if (e.target.value === "" || isNaN(parseFloat(e.target.value))) field.onChange(10); }}
                            data-testid="input-max-collateral"
                          />
                        </FormControl>
                        <FormDescription>Max collateral per trade</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="stopLossBps"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Stop Loss</FormLabel>
                        <span className="text-xs font-mono text-muted-foreground">
                          {field.value}bps ({(field.value / 100).toFixed(2)}%)
                        </span>
                      </div>
                      <FormControl>
                        <Slider
                          value={[field.value]}
                          onValueChange={(v) => field.onChange(v[0])}
                          min={10}
                          max={500}
                          step={10}
                          data-testid="slider-stop-loss"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="takeProfitBps"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Take Profit</FormLabel>
                        <span className="text-xs font-mono text-muted-foreground">
                          {field.value ?? 200}bps ({((field.value ?? 200) / 100).toFixed(2)}%)
                        </span>
                      </div>
                      <FormControl>
                        <Slider
                          value={[field.value ?? 200]}
                          onValueChange={(v) => field.onChange(v[0])}
                          min={25}
                          max={1000}
                          step={25}
                          data-testid="slider-take-profit"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="rewardSharePct"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <FormLabel>Profit Sharing</FormLabel>
                        <span className="text-xs font-mono font-bold" data-testid="text-reward-share-pct">{field.value}% rewards / {100 - field.value}% reinvest</span>
                      </div>
                      <FormControl>
                        <Slider
                          min={0}
                          max={100}
                          step={5}
                          value={[field.value]}
                          onValueChange={([val]) => field.onChange(val)}
                          data-testid="slider-reward-share"
                        />
                      </FormControl>
                      <FormDescription>
                        Split profits: rewards you can claim vs reinvested for compounding
                      </FormDescription>
                    </FormItem>
                  )}
                />

                <div className="bg-muted rounded-md p-3 space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Bot className="h-3 w-3 text-primary shrink-0" />
                    <span>Execution agent + signal sub-agent auto-paired</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Signal className="h-3 w-3 text-primary shrink-0" />
                    <span>Signal agent uses momentum strategy (3-of-6 conditions)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Coins className="h-3 w-3 shrink-0" />
                    <span>Agent starts with 0 SUI - fund after deployment</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Info className="h-3 w-3 shrink-0" />
                    <span>Protocol fee: {(PROTOCOL_FEE_RATE * 100).toFixed(0)}% on deposits</span>
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={createMutation.isPending}
                  data-testid="button-deploy-agent"
                >
                  <Zap className="h-4 w-4 mr-1" />
                  {createMutation.isPending ? "Deploying..." : "Deploy Agent Pair"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-primary/20 bg-primary/5" data-testid="card-how-it-works">
        <CardContent className="py-3">
          <h3 className="text-xs font-medium mb-2">Dual-Agent Architecture with DEX Execution</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1 bg-background rounded-md px-2 py-1">
              <Bot className="h-3 w-3 text-primary" />
              <span>Execution Agent</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1 bg-background rounded-md px-2 py-1">
              <Signal className="h-3 w-3 text-primary" />
              <span>Signal Sub-Agent</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1 bg-background rounded-md px-2 py-1">
              <Zap className="h-3 w-3 text-primary" />
              <span>Signal</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1 bg-background rounded-md px-2 py-1">
              <PlugZap className="h-3 w-3 text-primary" />
              <span>DEX SDK</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1 bg-background rounded-md px-2 py-1">
              <Activity className="h-3 w-3 text-primary" />
              <span>On-Chain Order</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge variant="default" className="text-[8px]">Typus Perps</Badge>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[1, 2].map((i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-8 w-full" /></CardHeader>
              <CardContent><Skeleton className="h-32 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : agents && agents.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-end">
            <TopOffAllButton agents={agents} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Bot className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-sm font-medium mb-1">No agents deployed</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Deploy your first execution + signal agent pair to start autonomous trading
            </p>
            <Button onClick={() => setOpen(true)} data-testid="button-empty-new-agent">
              <Plus className="h-4 w-4 mr-1" />
              Deploy Agent Pair
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
