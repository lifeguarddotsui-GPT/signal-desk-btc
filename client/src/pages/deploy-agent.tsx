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
} from "lucide-react";
import type { Agent } from "@shared/schema";

const deployAgentSchema = insertAgentSchema.extend({
  name: z.string().min(2, "Agent name must be at least 2 characters"),
  venue: z.string().min(1, "Please select a venue"),
  leverage: z.number().min(1).max(20),
  maxQty: z.number().min(0.01, "Minimum position size is 0.01"),
  stopLossBps: z.number().min(10).max(500),
  takeProfitBps: z.number().min(50).max(1000).optional().nullable(),
  autoTrade: z.boolean(),
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

function FundAgentDialog({ agent }: { agent: Agent }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);

  const depositMutation = useMutation({
    mutationFn: async () => {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) throw new Error("Invalid amount");
      await apiRequest("POST", `/api/agents/${agent.id}/deposit`, { amount: numAmount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Deposit recorded successfully" });
      setOpen(false);
      setAmount("");
    },
    onError: (error: Error) => {
      toast({ title: "Deposit failed", description: error.message, variant: "destructive" });
    },
  });

  const numAmount = parseFloat(amount) || 0;
  const protocolFee = numAmount * PROTOCOL_FEE_RATE;
  const netAmount = numAmount - protocolFee;

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
          <div className="bg-muted rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Agent Wallet</span>
              <div className="flex items-center gap-1">
                <span className="font-mono truncate max-w-[180px]">{agent.agentWallet}</span>
                <CopyButton text={agent.agentWallet || ""} />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Current Balance</span>
              <span className="font-mono font-bold">{agent.balance.toFixed(4)} SUI</span>
            </div>
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
              <div className="flex justify-between">
                <span className="text-muted-foreground">Deposit</span>
                <span className="font-mono">{numAmount.toFixed(4)} SUI</span>
              </div>
              <div className="flex justify-between text-chart-4">
                <span>Protocol Fee ({(PROTOCOL_FEE_RATE * 100).toFixed(0)}%)</span>
                <span className="font-mono">-{protocolFee.toFixed(4)} SUI</span>
              </div>
              <div className="border-t border-border pt-1.5 flex justify-between font-bold">
                <span>Net to Agent</span>
                <span className="font-mono">{netAmount.toFixed(4)} SUI</span>
              </div>
              <div className="flex items-center gap-1 text-muted-foreground mt-1">
                <Info className="h-3 w-3" />
                <span className="truncate">Fee to: {PROTOCOL_FEE_ADDRESS.slice(0, 10)}...{PROTOCOL_FEE_ADDRESS.slice(-6)}</span>
              </div>
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => depositMutation.mutate()}
            disabled={depositMutation.isPending || numAmount <= 0}
            data-testid="button-confirm-deposit"
          >
            {depositMutation.isPending ? "Processing..." : "Confirm Deposit"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const { toast } = useToast();

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

  const isRunning = agent.status === "running";
  const hasFunds = agent.balance > 0;

  return (
    <Card data-testid={`agent-card-${agent.id}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-md flex items-center justify-center ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-5 w-5 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <CardTitle className="text-sm font-medium">{agent.name}</CardTitle>
            <p className="text-xs text-muted-foreground font-mono">{agent.venue}</p>
          </div>
        </div>
        <Badge
          variant={isRunning ? "default" : "secondary"}
          data-testid={`badge-status-${agent.id}`}
        >
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />}
          {agent.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Balance</p>
            <p className="text-sm font-mono font-bold">{agent.balance.toFixed(2)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">PnL</p>
            <p className={`text-sm font-mono font-bold ${agent.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {agent.totalPnl >= 0 ? "+" : ""}{agent.totalPnl.toFixed(2)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Trades</p>
            <p className="text-sm font-mono font-bold">{agent.totalTrades}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Win Rate</p>
            <p className="text-sm font-mono font-bold">{(agent.winRate * 100).toFixed(0)}%</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-1">
          <div className="flex items-center gap-1">
            <Shield className="h-3 w-3" />
            <span>{agent.leverage}x</span>
          </div>
          <div className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            <span>SL: {agent.stopLossBps}bps</span>
          </div>
          {agent.takeProfitBps && (
            <div className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              <span>TP: {agent.takeProfitBps}bps</span>
            </div>
          )}
        </div>

        {agent.lastSignalSide && (
          <div className="bg-muted rounded-md px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Last Signal</span>
            <Badge variant={agent.lastSignalSide === "long" ? "default" : agent.lastSignalSide === "short" ? "destructive" : "secondary"}>
              {agent.lastSignalSide}
            </Badge>
          </div>
        )}

        {agent.agentWallet && (
          <div className="bg-muted rounded-md px-3 py-2 flex items-center gap-2">
            <Wallet className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate">
              {agent.agentWallet.slice(0, 10)}...{agent.agentWallet.slice(-6)}
            </span>
            <CopyButton text={agent.agentWallet} />
          </div>
        )}

        {!hasFunds && (
          <div className="bg-chart-4/10 border border-chart-4/30 rounded-md px-3 py-2 flex items-center gap-2">
            <Info className="h-3 w-3 text-chart-4 flex-shrink-0" />
            <span className="text-xs text-chart-4">Fund this agent to start trading</span>
          </div>
        )}

        <div className="flex gap-2">
          <FundAgentDialog agent={agent} />
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
        </div>
      </CardContent>
    </Card>
  );
}

export default function DeployAgent() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  usePageSEO({
    title: "Deploy Agent",
    description: "Configure and deploy AI trading agents for SUI-PERP perpetual trading on Lifeguard.sui",
  });

  const form = useForm<DeployAgentForm>({
    resolver: zodResolver(deployAgentSchema),
    defaultValues: {
      userId: "default-user",
      name: "",
      venue: "sudo",
      leverage: 5,
      maxQty: 1,
      stopLossBps: 80,
      takeProfitBps: 200,
      autoTrade: false,
    },
  });

  const { data: agents, isLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents"],
  });

  const createMutation = useMutation({
    mutationFn: async (values: DeployAgentForm) => {
      await apiRequest("POST", "/api/agents", values);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent deployed successfully", description: "Fund your agent's wallet to start trading" });
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
    <div className="p-4 md:p-6 space-y-4 md:space-y-6" data-testid="page-deploy-agent">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Deploy Agent</h2>
          <p className="text-sm text-muted-foreground">Configure, fund, and launch your AI trading agents</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-agent">
              <Plus className="h-4 w-4 mr-1" />
              New Agent
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                Deploy New Agent
              </DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 pt-2">
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
                      <FormLabel>Venue</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-venue">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="sudo">Sudo Perps</SelectItem>
                          <SelectItem value="typus">Typus Perps</SelectItem>
                          <SelectItem value="flowx">FlowX Perp</SelectItem>
                          <SelectItem value="zofai">ZoFAI</SelectItem>
                        </SelectContent>
                      </Select>
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
                          max={20}
                          step={1}
                          data-testid="slider-leverage"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxQty"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Position Size (SUI)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          {...field}
                          onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                          data-testid="input-max-qty"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="stopLossBps"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Stop Loss</FormLabel>
                        <span className="text-sm font-mono text-muted-foreground">
                          {field.value} bps ({(field.value / 100).toFixed(2)}%)
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
                        <span className="text-sm font-mono text-muted-foreground">
                          {field.value ?? 200} bps ({((field.value ?? 200) / 100).toFixed(2)}%)
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

                <div className="bg-muted rounded-md p-3 space-y-1 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Info className="h-3 w-3" />
                    <span>Agent starts with 0 SUI balance</span>
                  </div>
                  <div className="text-muted-foreground">
                    A unique wallet will be generated. Fund it after deployment.
                  </div>
                  <div className="text-muted-foreground">
                    Protocol fee: {(PROTOCOL_FEE_RATE * 100).toFixed(0)}% on deposits
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={createMutation.isPending}
                  data-testid="button-deploy-agent"
                >
                  <Zap className="h-4 w-4 mr-1" />
                  {createMutation.isPending ? "Deploying..." : "Deploy Agent"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-primary/20 bg-primary/5" data-testid="card-how-it-works">
        <CardContent className="py-4">
          <h3 className="text-sm font-medium mb-3">How It Works</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5 bg-background rounded-md px-3 py-1.5">
              <Wallet className="h-3 w-3 text-primary" />
              <span>Connect Wallet</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1.5 bg-background rounded-md px-3 py-1.5">
              <Bot className="h-3 w-3 text-primary" />
              <span>Configure Agent</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1.5 bg-background rounded-md px-3 py-1.5">
              <Coins className="h-3 w-3 text-primary" />
              <span>Fund Agent Wallet</span>
            </div>
            <ArrowRight className="h-3 w-3" />
            <div className="flex items-center gap-1.5 bg-background rounded-md px-3 py-1.5">
              <Play className="h-3 w-3 text-primary" />
              <span>Start Trading</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-8 space-y-3">
            <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <div className="text-center">
              <h3 className="text-sm font-medium">Execution Agent</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Manages orders, risk controls, and stop-loss execution
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="h-3 w-3" />
              <span>Limit entry + Stop Loss always active</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-8 space-y-3">
            <div className="w-12 h-12 rounded-md bg-chart-2/10 flex items-center justify-center">
              <Activity className="h-6 w-6 text-chart-2" />
            </div>
            <div className="text-center">
              <h3 className="text-sm font-medium">Market Agent</h3>
              <p className="text-xs text-muted-foreground mt-1">
                RSI + Connors RSI + EMA/DEMA/TEMA signals
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="h-3 w-3" />
              <span>Score-based signal generation (3/6 min)</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-3"><Skeleton className="h-5 w-32" /></CardHeader>
              <CardContent><Skeleton className="h-32 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          {agents && agents.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-3">Your Agents</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </div>
            </div>
          ) : (
            <Card>
              <CardContent className="text-center py-12">
                <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                <h3 className="text-sm font-medium mb-1">No agents deployed</h3>
                <p className="text-xs text-muted-foreground">
                  Click "New Agent" above to deploy your first trading agent
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
