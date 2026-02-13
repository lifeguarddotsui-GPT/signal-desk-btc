import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
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
import { insertAgentSchema, PROTOCOL_FEE_RATE, PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import type { AgentWithSignalAgent } from "@shared/schema";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
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
  CircleDot,
  Trash2,
  TrendingUp,
} from "lucide-react";

const deployAgentSchema = insertAgentSchema.extend({
  name: z.string().min(2, "Agent name must be at least 2 characters"),
  venue: z.enum(["typus", "astros"], { errorMap: () => ({ message: "Please select a Perps DEX venue" }) }),
  leverage: z.number().min(1).max(25),
  maxQty: z.number().min(0.01, "Minimum position size is 0.01"),
  stopLossBps: z.number().min(10).max(500),
  takeProfitBps: z.number().min(50).max(1000).optional().nullable(),
  autoTrade: z.boolean(),
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
      tx.setSender(account.address);

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

      await new Promise((resolve) => setTimeout(resolve, 2000));

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
              <span className="font-mono font-bold">{agent.balance.toFixed(4)} SUI</span>
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

          <div className="bg-muted/50 rounded-md p-2 text-[10px] text-muted-foreground space-y-1">
            <p>This will create an on-chain SUI transaction:</p>
            <p>1. Transfer {netAmount > 0 ? netAmount.toFixed(4) : "—"} SUI to agent wallet</p>
            <p>2. Transfer {protocolFee > 0 ? protocolFee.toFixed(4) : "—"} SUI protocol fee</p>
            <p>3. Verify transaction on SUI mainnet</p>
          </div>

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
            <FormLabel>Max Position Size (SUI)</FormLabel>
            <FormControl>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="1.00"
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
            <FormDescription>Maximum SUI per trade position</FormDescription>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

const VENUE_LABELS: Record<string, { name: string; type: string; supported: boolean }> = {
  typus: { name: "Typus Finance", type: "perp", supported: true },
  astros: { name: "Astros Perps", type: "perp", supported: true },
};

function AgentCard({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const venueInfo = VENUE_LABELS[agent.venue] || { name: agent.venue, type: "unknown", supported: false };

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const newStatus = agent.status === "running" ? "idle" : "running";
      await apiRequest("PATCH", `/api/agents/${agent.id}`, { status: newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: agent.status === "running" ? "Agent stopped" : "Agent started" });
    },
  });

  const autoTradeMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/agents/${agent.id}`, { autoTrade: !agent.autoTrade });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: agent.autoTrade ? "Auto-trade disabled" : "Auto-trade enabled" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      await apiRequest("DELETE", `/api/agents/${agent.id}${walletParam}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent deleted", description: `${agent.name} has been removed` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete agent", description: error.message, variant: "destructive" });
    },
  });

  const isRunning = agent.status === "running";
  const hasFunds = agent.balance > 0;

  return (
    <Card data-testid={`agent-card-${agent.id}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4 w-4 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium truncate">{agent.name}</CardTitle>
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
          <Badge
            variant={isRunning ? "default" : "secondary"}
            data-testid={`badge-status-${agent.id}`}
          >
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />}
            {agent.status}
          </Badge>
          {agent.autoTrade && (
            <Badge variant="default" className="text-[8px] px-1 py-0 bg-amber-600">
              <CircleDot className="h-2 w-2 mr-0.5" />
              AUTO
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-1">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Balance</p>
            <p className="text-xs font-mono font-bold">{agent.balance.toFixed(2)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">PnL</p>
            <p className={`text-xs font-mono font-bold ${agent.totalPnl > 0 ? "text-emerald-500" : agent.totalPnl < 0 ? "text-red-500" : "text-muted-foreground"}`}>
              {agent.totalPnl === 0 ? "0.00" : `${agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toFixed(2)}`}
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Trades</p>
            <p className="text-xs font-mono font-bold">{agent.totalTrades}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Win</p>
            <p className="text-xs font-mono font-bold">{(agent.winRate * 100).toFixed(0)}%</p>
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

        <div className="flex gap-2">
          <FundAgentDialog agent={agent} />
          <Button
            variant="outline"
            onClick={() => autoTradeMutation.mutate()}
            disabled={autoTradeMutation.isPending}
            className={`toggle-elevate ${agent.autoTrade ? "toggle-elevated" : ""}`}
            data-testid={`button-auto-trade-${agent.id}`}
          >
            <CircleDot className="h-4 w-4 mr-1" />
            {agent.autoTrade ? "Auto" : "Manual"}
          </Button>
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
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={isRunning || deleteMutation.isPending || !account?.address}
                title={!account?.address ? "Connect wallet to delete" : isRunning ? "Stop agent first" : "Delete agent"}
                data-testid={`button-delete-${agent.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete "{agent.name}" and all its trading history, signals, and orders. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
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

  usePageSEO({
    title: "Deploy Agent",
    description: "Configure and deploy AI trading agents for SUI-PERP perpetual trading on Blue Water Agents",
  });

  const form = useForm<DeployAgentForm>({
    resolver: zodResolver(deployAgentSchema),
    defaultValues: {
      userId: "default-user",
      name: "",
      venue: "typus",
      leverage: 5,
      maxQty: 1,
      stopLossBps: 80,
      takeProfitBps: 200,
      autoTrade: false,
      rewardSharePct: 50,
    },
  });

  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
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

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-deploy-agent">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <h2 className="text-lg md:text-xl font-bold tracking-tight">Deploy Agent</h2>
          <p className="text-xs text-muted-foreground">Execution + Signal agent pairs for autonomous trading</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-agent">
              <Plus className="h-4 w-4 mr-1" />
              New Agent
            </Button>
          </DialogTrigger>
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
                          <SelectItem value="typus">Typus Finance (SDK Ready)</SelectItem>
                          <SelectItem value="astros">Astros Perps (SDK Ready)</SelectItem>
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
                          max={25}
                          step={1}
                          data-testid="slider-leverage"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <MaxQtyField control={form.control} />

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
                          min={50}
                          max={1000}
                          step={50}
                          data-testid="slider-take-profit"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="autoTrade"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <FormLabel>Auto Trade</FormLabel>
                        <FormDescription>Execute signals automatically</FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="switch-auto-trade"
                        />
                      </FormControl>
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
            <Badge variant="default" className="text-[8px]">Typus Finance</Badge>
            <Badge variant="default" className="text-[8px]">Astros Perps</Badge>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
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
