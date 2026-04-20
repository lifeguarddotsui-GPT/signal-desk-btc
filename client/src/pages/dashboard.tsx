import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLivePrice } from "@/lib/ws-context";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClientQuery } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import {
  Bot, Play, Square, Gift, Coins, CheckCircle, Clock, TrendingUp,
  Wallet, Plus, Activity, AlertTriangle, BarChart2, Settings2,
  ArrowDownToLine, ArrowUpFromLine, Trash2, ExternalLink, RefreshCw, XCircle,
} from "lucide-react";

// ─── types ────────────────────────────────────────────────────────────────────

type TradeRecord = {
  id: string;
  symbol: string;
  side: "long" | "short";
  status: "open" | "closed";
  entryReason: string;
  exitReason?: string;
  entryTs: number;
  exitTs?: number;
  entryPrice: number;
  exitPrice?: number;
  leverage: number;
  collateralSui: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  pnlSui?: number;
  pnlBps?: number;
  win?: boolean;
  atrRatioAtEntry: number;
  volumeRatioAtEntry: number;
  trendBiasAtEntry: "bullish" | "bearish" | "neutral";
  breakoutLevel: number;
};

type EngineState = {
  isEnabled: boolean;
  lastScanTs: number | null;
  cooldownUntilTs: number | null;
  currentTradeId: string | null;
  consecutiveLosses: number;
  dailyRealizedPnlSui: number;
  dailyResetTs: number | null;
  lastError?: string;
};

type ScanDecision = {
  regime: { tradeable: boolean; atrRatio: number; volumeRatio: number; trendBias: string; blockReason?: string };
  decision: { shouldTrade: boolean; reason?: string; side?: string; breakoutLevel?: number };
  atTs: number;
};

type Agent = {
  id: string;
  userId: string;
  name: string;
  status: string;
  autoTrade: boolean;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  leverage: number;
  minCollateral: number;
  maxCollateral: number;
  stopLossBps: number;
  takeProfitBps: number | null;
  balance: number;
  totalDeposited: number;
  walletAddress: string | null;
  createdAt: string;
};

type Reward = {
  id: string;
  userId: string;
  agentId: string;
  amount: number;
  status: "pending" | "claimed";
  claimedAt: string | null;
  createdAt: string;
};

type RewardSummary = {
  totalPending: number;
  totalClaimed: number;
  totalEarned: number;
  rewards: Reward[];
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, digits = 4): string {
  if (n == null) return "--";
  return n.toFixed(digits);
}

function fmtTs(ts: number | string | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts as any).toLocaleTimeString();
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleDateString();
}

function pnlColor(v: number | undefined | null) {
  if (v == null) return "text-muted-foreground";
  return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
}

function sideColor(side: "long" | "short") {
  return side === "long" ? "text-emerald-400" : "text-red-400";
}

function WalletGate({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount();
  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Wallet className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">Connect your wallet</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Connect your SUI wallet using the button in the top-right corner to access your agent.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

// ─── Settings dialog ──────────────────────────────────────────────────────────

function AgentSettingsDialog({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [leverage, setLeverage] = useState(String(agent.leverage));
  const [minCol, setMinCol] = useState(String(agent.minCollateral));
  const [maxCol, setMaxCol] = useState(String(agent.maxCollateral));
  const [slBps, setSlBps] = useState(String(agent.stopLossBps));
  const [tpBps, setTpBps] = useState(String(agent.takeProfitBps ?? 50));
  const [rewardPct, setRewardPct] = useState(String(agent.rewardSharePct ?? 10));

  function handleOpen(o: boolean) {
    if (o) {
      setLeverage(String(agent.leverage));
      setMinCol(String(agent.minCollateral));
      setMaxCol(String(agent.maxCollateral));
      setSlBps(String(agent.stopLossBps));
      setTpBps(String(agent.takeProfitBps ?? 50));
      setRewardPct(String(agent.rewardSharePct ?? 10));
    }
    setOpen(o);
  }

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/agents/${agent.id}`, {
      leverage: parseInt(leverage, 10),
      minCollateral: parseFloat(minCol),
      maxCollateral: parseFloat(maxCol),
      stopLossBps: parseInt(slBps, 10),
      takeProfitBps: parseInt(tpBps, 10),
      rewardSharePct: parseInt(rewardPct, 10),
    }),
    onSuccess: () => {
      onSaved();
      setOpen(false);
      toast({ title: "Settings saved" });
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const leverageN = parseInt(leverage, 10) || 0;
  const minColN = parseFloat(minCol) || 0;
  const maxColN = parseFloat(maxCol) || 0;
  const slBpsN = parseInt(slBps, 10) || 0;
  const tpBpsN = parseInt(tpBps, 10) || 0;
  const rewardPctN = parseInt(rewardPct, 10) || 0;
  const reinvestPct = 100 - rewardPctN;

  const isValid =
    leverageN >= 1 && leverageN <= 50 &&
    minColN >= 0.5 && minColN <= 50 &&
    maxColN >= minColN &&
    slBpsN >= 10 && slBpsN <= 500 &&
    tpBpsN >= 10 && tpBpsN <= 2000 &&
    rewardPctN >= 0 && rewardPctN <= 50;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-agent-settings">
          <Settings2 className="h-3.5 w-3.5 mr-1.5" />
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Agent Configuration</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-leverage" className="text-xs">Leverage (1–50x)</Label>
              <Input
                id="cfg-leverage"
                type="number"
                min={1} max={50}
                value={leverage}
                onChange={e => setLeverage(e.target.value)}
                data-testid="input-leverage"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Current: {agent.leverage}x</Label>
              <div className="h-9 flex items-center px-3 rounded-md bg-muted text-xs font-mono text-muted-foreground">
                {leverageN}x → {leverageN}x
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <p className="text-xs font-medium mb-2">Collateral per Trade (SUI)</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cfg-min-col" className="text-xs">Min collateral</Label>
                <Input
                  id="cfg-min-col"
                  type="number"
                  min={0.5} max={50} step={0.5}
                  value={minCol}
                  onChange={e => setMinCol(e.target.value)}
                  data-testid="input-min-collateral"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cfg-max-col" className="text-xs">Max collateral</Label>
                <Input
                  id="cfg-max-col"
                  type="number"
                  min={0.5} max={100} step={0.5}
                  value={maxCol}
                  onChange={e => setMaxCol(e.target.value)}
                  data-testid="input-max-collateral"
                />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">
              Engine picks a random amount between min and max for each trade.
            </p>
          </div>

          <Separator />

          <div>
            <p className="text-xs font-medium mb-2">Exit Parameters</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cfg-sl" className="text-xs">Stop Loss (bps)</Label>
                <Input
                  id="cfg-sl"
                  type="number"
                  min={10} max={500}
                  value={slBps}
                  onChange={e => setSlBps(e.target.value)}
                  data-testid="input-stop-loss"
                />
                <p className="text-[10px] text-muted-foreground">{slBpsN}bps = {(slBpsN / 100).toFixed(2)}%</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cfg-tp" className="text-xs">Take Profit (bps)</Label>
                <Input
                  id="cfg-tp"
                  type="number"
                  min={10} max={2000}
                  value={tpBps}
                  onChange={e => setTpBps(e.target.value)}
                  data-testid="input-take-profit"
                />
                <p className="text-[10px] text-muted-foreground">{tpBpsN}bps = {(tpBpsN / 100).toFixed(2)}%</p>
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <p className="text-xs font-medium mb-1">Profit Split — Rewards vs Reinvest</p>
            <p className="text-[10px] text-muted-foreground mb-3">
              When a trade wins, this % of PnL is credited to your claimable rewards. The rest stays in the agent.
            </p>
            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span className="font-medium text-primary">{rewardPctN}% → Rewards</span>
                <span className="font-medium text-emerald-400">{reinvestPct}% → Agent</span>
              </div>
              <input
                type="range"
                min={0} max={50} step={5}
                value={rewardPctN}
                onChange={e => setRewardPct(e.target.value)}
                className="w-full accent-primary"
                data-testid="slider-reward-pct"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0%</span>
                <span>25%</span>
                <span>50%</span>
              </div>
            </div>
          </div>

          {!isValid && (
            <p className="text-[11px] text-orange-400">
              {maxColN < minColN ? "Max collateral must be ≥ min collateral." : "Check that all values are within the allowed ranges."}
            </p>
          )}

          <Button
            className="w-full"
            disabled={!isValid || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            data-testid="button-save-settings"
          >
            {saveMutation.isPending ? "Saving…" : "Save Configuration"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Withdraw dialog ──────────────────────────────────────────────────────────

function WithdrawDialog({ agent, wallet, onWithdrawn }: { agent: Agent; wallet: string; onWithdrawn: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [isPending, setIsPending] = useState(false);

  const amountN = parseFloat(amount) || 0;

  const { data: balData } = useQuery<{ balanceSui: number }>({
    queryKey: ["/api/agents", agent.id, "wallet-balance"],
    queryFn: () => fetch(`/api/agents/${agent.id}/wallet-balance`).then(r => r.json()),
    enabled: open,
    refetchInterval: 10000,
  });

  const GAS_RESERVE = 0.05;
  const available = Math.max(0, (balData?.balanceSui ?? 0) - GAS_RESERVE);
  const isValid = amountN > 0 && amountN <= available && !!wallet;

  async function handleWithdraw() {
    if (!isValid) return;
    setIsPending(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toAddress: wallet, amountSui: amountN }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "withdraw_failed");
      onWithdrawn();
      setOpen(false);
      setAmount("");
      toast({ title: "Withdrawal sent", description: `${amountN.toFixed(3)} SUI → your wallet. TX: ${data.txDigest?.slice(0, 12)}…` });
    } catch (err: any) {
      toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!isPending) setOpen(o); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-withdraw">
          <ArrowUpFromLine className="h-3.5 w-3.5 mr-1.5" />
          Withdraw
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Withdraw from Agent</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Available to withdraw</p>
            <p className="font-bold font-mono text-foreground" data-testid="text-withdraw-available">
              {available.toFixed(3)} SUI <span className="text-[10px] font-normal text-muted-foreground">(0.05 reserved for gas)</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <Label htmlFor="withdraw-amount" className="text-xs">Amount (SUI)</Label>
              <button className="text-[10px] text-primary underline" onClick={() => setAmount(available.toFixed(4))}>Max</button>
            </div>
            <Input
              id="withdraw-amount"
              type="number"
              min={0.001}
              step={0.5}
              placeholder="e.g. 10"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={isPending}
              data-testid="input-withdraw-amount"
            />
          </div>

          {amountN > 0 && (
            <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Destination: <span className="font-mono text-foreground">{wallet.slice(0, 10)}…{wallet.slice(-6)}</span>
            </div>
          )}

          <Button className="w-full" disabled={!isValid || isPending} onClick={handleWithdraw} data-testid="button-confirm-withdraw">
            {isPending ? "Sending…" : `Withdraw ${amountN > 0 ? amountN.toFixed(3) : ""} SUI`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Deposit dialog ───────────────────────────────────────────────────────────

function DepositDialog({ agent, wallet, onDeposited }: { agent: Agent; wallet: string; onDeposited: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<"input" | "signing" | "verifying">("input");
  const qc = useQueryClient();

  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const amountN = parseFloat(amount) || 0;
  const isValid = amountN >= 0.01 && !!agent.walletAddress;

  function handleDeposit() {
    if (!isValid || !agent.walletAddress) return;

    const tx = new Transaction();
    const amountMist = BigInt(Math.round(amountN * 1_000_000_000));
    const [coin] = tx.splitCoins(tx.gas, [amountMist]);
    tx.transferObjects([coin], agent.walletAddress);

    setStep("signing");
    signAndExecute(
      { transaction: tx },
      {
        onSuccess: async (result) => {
          setStep("verifying");
          try {
            const res = await fetch(`/api/agents/${agent.id}/deposit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                txDigest: result.digest,
                depositorAddress: wallet,
                amount: amountN,
              }),
            });
            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.error ?? "deposit_failed");
            }
            qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
            onDeposited();
            setOpen(false);
            setAmount("");
            toast({
              title: "Deposit confirmed",
              description: `${(data.verifiedAmount ?? amountN).toFixed(3)} SUI credited to your agent.`,
            });
          } catch (err: any) {
            toast({ title: "Deposit recording failed", description: err.message, variant: "destructive" });
          } finally {
            setStep("input");
          }
        },
        onError: (err) => {
          setStep("input");
          const msg = err?.message ?? "Transaction rejected";
          if (!msg.includes("Cancel") && !msg.includes("reject")) {
            toast({ title: "Transaction failed", description: msg, variant: "destructive" });
          }
        },
      }
    );
  }

  const stepLabel = step === "signing" ? "Waiting for wallet…" : step === "verifying" ? "Verifying on-chain…" : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (step === "input") setOpen(o); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-deposit">
          <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
          Deposit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Deposit SUI to Agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-muted px-3 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Agent Balance</p>
              <p className="font-bold font-mono mt-0.5" data-testid="text-current-balance">{(agent.balance ?? 0).toFixed(3)} SUI</p>
            </div>
            <div className="rounded-md bg-muted px-3 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Deposited</p>
              <p className="font-bold font-mono mt-0.5" data-testid="text-total-deposited">{(agent.totalDeposited ?? 0).toFixed(3)} SUI</p>
            </div>
          </div>

          {agent.walletAddress ? (
            <div className="rounded-md bg-muted px-3 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Agent Wallet (destination)</p>
              <p className="font-mono text-[10px] break-all text-foreground" data-testid="text-agent-wallet">{agent.walletAddress}</p>
            </div>
          ) : (
            <div className="rounded-md border border-orange-400/20 bg-orange-400/5 px-3 py-2 text-xs text-orange-400">
              Agent wallet not yet generated. Please delete and recreate your agent.
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="deposit-amount" className="text-xs">Amount (SUI)</Label>
            <Input
              id="deposit-amount"
              type="number"
              min={0.01}
              step={0.5}
              placeholder="e.g. 10"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={step !== "input"}
              data-testid="input-deposit-amount"
            />
          </div>

          {amountN > 0 && (
            <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2 text-xs">
              <p className="text-muted-foreground">Balance after deposit</p>
              <p className="font-bold font-mono text-primary mt-0.5">{((agent.balance ?? 0) + amountN).toFixed(3)} SUI</p>
            </div>
          )}

          <div className="rounded-md bg-muted p-3 text-[11px] text-muted-foreground">
            Your connected wallet will prompt you to sign a SUI transfer to your agent's on-chain address. The backend verifies the transaction before crediting your balance.
          </div>

          <Button
            className="w-full"
            disabled={!isValid || step !== "input"}
            onClick={handleDeposit}
            data-testid="button-confirm-deposit"
          >
            {stepLabel ?? `Send ${amountN > 0 ? amountN.toFixed(2) : ""} SUI`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── My Agent tab ─────────────────────────────────────────────────────────────

function MyAgentTab() {
  const account = useCurrentAccount();
  const wallet = account?.address ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const livePrice = useLivePrice();
  const wsPrice = livePrice?.blended ?? livePrice?.pyth?.price ?? livePrice?.price ?? null;

  // HTTP polling fallback — kicks in when WebSocket hasn't provided a price yet
  const { data: httpPriceData } = useQuery<{ blended?: number; pyth?: { price: number } }>({
    queryKey: ["/api/market/price"],
    refetchInterval: 3000,
    enabled: wsPrice === null,
  });
  const httpPrice = httpPriceData?.blended ?? httpPriceData?.pyth?.price ?? null;
  const currentPrice = wsPrice ?? httpPrice;

  // Connected wallet real SUI balance
  const { data: walletBalData, refetch: refetchWalletBal } = useSuiClientQuery(
    "getBalance",
    { owner: wallet, coinType: "0x2::sui::SUI" },
    { enabled: !!wallet, refetchInterval: 15000 }
  );
  const walletBalSui = walletBalData?.totalBalance
    ? Number(BigInt(walletBalData.totalBalance)) / 1e9
    : null;

  const { data: agentList = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents", wallet],
    queryFn: () => fetch(`/api/agents?wallet=${encodeURIComponent(wallet)}`).then(r => r.json()),
    enabled: !!wallet,
    refetchInterval: 5000,
  });

  const agent = agentList[0] ?? null;

  // Real on-chain SUI balance of agent wallet
  const { data: agentBalData, refetch: refetchAgentBal } = useQuery<{ balanceSui: number; walletAddress: string | null }>({
    queryKey: ["/api/agents", agent?.id, "wallet-balance"],
    queryFn: () => fetch(`/api/agents/${agent!.id}/wallet-balance`).then(r => r.json()),
    enabled: !!agent,
    refetchInterval: 15000,
  });

  const { data: trades = [] } = useQuery<TradeRecord[]>({
    queryKey: ["/api/engine/trades", agent?.id],
    queryFn: () => fetch(`/api/engine/trades?agentId=${agent!.id}&limit=50`).then(r => r.json()),
    enabled: !!agent,
    refetchInterval: 5000,
  });

  const { data: summary } = useQuery<{ total: number; wins: number; losses: number; winRate: number; pnlSui: number; avgWinner: number; avgLoser: number }>({
    queryKey: ["/api/engine/summary", agent?.id],
    queryFn: () => fetch(`/api/engine/summary?agentId=${agent!.id}`).then(r => r.json()),
    enabled: !!agent,
    refetchInterval: 10000,
  });

  const { data: engineData } = useQuery<{ state: EngineState; scanDecision: ScanDecision | null }>({
    queryKey: ["/api/engine/state"],
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/agents", { name, userId: wallet }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
      toast({ title: "Agent created" });
      setCreateOpen(false);
      setAgentName("");
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message ?? "Failed to create agent", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: (a: Agent) => {
      const isActive = a.status === "active" && a.autoTrade;
      return apiRequest("PATCH", `/api/agents/${a.id}`, { status: isActive ? "idle" : "active", autoTrade: !isActive });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents", wallet] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });
      toast({ title: "Agent deleted" });
      setConfirmDelete(false);
    },
  });

  const closeMutation = useMutation({
    mutationFn: (agentId: string) => apiRequest("POST", `/api/agents/${agentId}/close-position`, {}),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/engine/trades", agent?.id] });
      qc.invalidateQueries({ queryKey: ["/api/engine/state"] });
      qc.invalidateQueries({ queryKey: ["/api/engine/summary", agent?.id] });
      const pnl = data?.pnlSui;
      toast({
        title: "Position closed",
        description: pnl != null
          ? `Exit @ $${data.exitPrice?.toFixed(4)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SUI`
          : "Position closed at market price",
      });
    },
    onError: (e: any) => toast({ title: "Close failed", description: e?.message, variant: "destructive" }),
  });

  if (!wallet) return null;

  if (agentsLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const engineState = engineData?.state;
  const scanDecision = engineData?.scanDecision;
  const openTrade = trades.find(t => t.status === "open") ?? null;
  const isAgentActive = agent?.status === "active" && agent?.autoTrade;
  const isEngineRunning = engineState?.isEnabled;

  // Live unrealized PnL for open position
  const unrealizedPnl = openTrade && currentPrice
    ? (() => {
        const raw = openTrade.side === "long"
          ? currentPrice - openTrade.entryPrice
          : openTrade.entryPrice - currentPrice;
        return openTrade.collateralSui * openTrade.leverage * (raw / openTrade.entryPrice);
      })()
    : null;

  // Liquidation price (approx: ~90% of margin consumed)
  const liqPrice = openTrade
    ? openTrade.side === "long"
      ? openTrade.entryPrice * (1 - 0.9 / openTrade.leverage)
      : openTrade.entryPrice * (1 + 0.9 / openTrade.leverage)
    : null;

  // Position age
  const posAge = openTrade
    ? Math.floor((Date.now() - openTrade.entryTs) / 1000)
    : null;

  const closedTrades = trades.filter(t => t.status === "closed");
  const invalidateAgent = () => qc.invalidateQueries({ queryKey: ["/api/agents", wallet] });

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="h-8 w-8 text-primary" />
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">No agent yet</h3>
          <p className="text-sm text-muted-foreground max-w-xs mb-4">
            Create your breakout trading agent for SUI-USDC perpetuals on Typus Finance.
          </p>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-agent"><Plus className="h-4 w-4 mr-1.5" />Create Agent</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create Trading Agent</DialogTitle></DialogHeader>
              <div className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Agent name</Label>
                  <Input id="agent-name" placeholder="e.g. Breakout Alpha" value={agentName}
                    onChange={e => setAgentName(e.target.value)} data-testid="input-agent-name" />
                </div>
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground mb-1">Default config (adjustable after creation)</p>
                  <p>Strategy: ATR + Volume breakout on SUI-USDC perps</p>
                  <p>Leverage: 30x · Collateral: 3–4 SUI/trade</p>
                  <p>Take Profit: 50bps · Stop Loss: 35bps · Max hold: 15 min</p>
                </div>
                <Button className="w-full" disabled={agentName.trim().length < 2 || createMutation.isPending}
                  onClick={() => createMutation.mutate(agentName.trim())} data-testid="button-confirm-create">
                  {createMutation.isPending ? "Deploying…" : "Deploy Agent"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">

      {/* ── Market stats bar ── */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs px-1">
        <span className="text-muted-foreground">
          SUI/USD{" "}
          <span className="font-mono font-semibold text-foreground" data-testid="text-market-price">
            {currentPrice ? `$${currentPrice.toFixed(4)}` : "—"}
          </span>
        </span>
        {scanDecision && (
          <>
            <span className="text-muted-foreground">
              ATR ratio{" "}
              <span className={`font-mono font-semibold ${scanDecision.regime.atrRatio >= 0.8 ? "text-emerald-400" : "text-muted-foreground"}`}>
                {scanDecision.regime.atrRatio.toFixed(2)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Vol ratio{" "}
              <span className={`font-mono font-semibold ${scanDecision.regime.volumeRatio >= 0.7 ? "text-emerald-400" : "text-muted-foreground"}`}>
                {scanDecision.regime.volumeRatio.toFixed(2)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Trend{" "}
              <span className={`font-mono font-semibold capitalize ${
                scanDecision.regime.trendBias === "bullish" ? "text-emerald-400" :
                scanDecision.regime.trendBias === "bearish" ? "text-red-400" : "text-muted-foreground"
              }`}>{scanDecision.regime.trendBias}</span>
            </span>
            <Badge variant="outline" className={`text-[10px] h-4 ${scanDecision.decision.shouldTrade ? "text-emerald-400 border-emerald-400/30" : "text-orange-400 border-orange-400/30"}`}>
              {scanDecision.decision.shouldTrade ? "TRADEABLE" : "BLOCKED"}
            </Badge>
          </>
        )}
        {walletBalSui !== null && (
          <span className="text-muted-foreground ml-auto flex items-center gap-1">
            <Wallet className="h-3 w-3" />
            Your wallet:{" "}
            <span className="font-mono font-semibold text-foreground" data-testid="text-wallet-balance">
              {walletBalSui.toFixed(3)} SUI
            </span>
            <button onClick={() => refetchWalletBal()} className="text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
      </div>

      {/* ── Agent header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-md flex items-center justify-center ${isAgentActive ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4.5 w-4.5 ${isAgentActive ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h2 className="text-sm font-semibold">{agent.name}</h2>
            <p className="text-[10px] text-muted-foreground font-mono">{wallet.slice(0, 10)}…{wallet.slice(-6)}</p>
          </div>
          <Badge variant="outline"
            className={isAgentActive ? "text-emerald-400 border-emerald-400/30" : "text-muted-foreground"}
            data-testid="badge-agent-status">
            {isAgentActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />}
            {isAgentActive ? "ACTIVE" : "IDLE"}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <DepositDialog agent={agent} wallet={wallet} onDeposited={invalidateAgent} />
          <WithdrawDialog agent={agent} wallet={wallet} onWithdrawn={invalidateAgent} />
          <AgentSettingsDialog agent={agent} onSaved={invalidateAgent} />
          <Button variant={isAgentActive ? "destructive" : "default"} size="sm"
            disabled={toggleMutation.isPending || (!isEngineRunning && !isAgentActive)}
            onClick={() => toggleMutation.mutate(agent)} data-testid="button-toggle-agent">
            {isAgentActive ? <><Square className="h-3.5 w-3.5 mr-1" />Deactivate</> : <><Play className="h-3.5 w-3.5 mr-1" />Activate</>}
          </Button>
          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" data-testid="button-delete-agent">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xs">
              <DialogHeader><DialogTitle>Delete agent?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">
                This removes <span className="font-semibold text-foreground">{agent.name}</span> from the system. The agent wallet and any funds in it will still exist on-chain — only the DB record is deleted.
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                <Button variant="destructive" className="flex-1"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(agent.id)}
                  data-testid="button-confirm-delete">
                  {deleteMutation.isPending ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!isEngineRunning && (
        <div className="flex items-center gap-2 rounded-md border border-orange-400/20 bg-orange-400/5 px-3 py-2 text-xs text-orange-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          Engine is stopped — start it from the Engine tab before activating your agent.
        </div>
      )}

      {/* ── Stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Agent Balance</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-balance">
              {agentBalData?.balanceSui != null ? `${agentBalData.balanceSui.toFixed(3)} SUI` : "—"}
            </p>
            <p className="text-[9px] text-muted-foreground mt-0.5 flex items-center gap-1">
              on-chain
              <button onClick={() => refetchAgentBal()} className="hover:text-foreground transition-colors">
                <RefreshCw className="h-2.5 w-2.5" />
              </button>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Total PnL</p>
            <p className={`text-lg font-bold font-mono ${pnlColor(summary?.pnlSui)}`} data-testid="text-agent-pnl">
              {summary ? `${summary.pnlSui >= 0 ? "+" : ""}${fmt(summary.pnlSui, 3)} SUI` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Trades</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-trades">{summary?.total ?? "—"}</p>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {summary?.total ? `${summary.wins}W / ${summary.losses}L` : ""}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Win Rate</p>
            <p className="text-lg font-bold font-mono" data-testid="text-agent-winrate">
              {summary?.total ? `${(summary.winRate * 100).toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Config strip ── */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs px-1">
        <span className="text-muted-foreground">Leverage <span className="font-mono font-semibold text-foreground">{agent.leverage}x</span></span>
        <span className="text-muted-foreground">Collateral <span className="font-mono font-semibold text-foreground">{agent.minCollateral}–{agent.maxCollateral} SUI</span></span>
        <span className="text-muted-foreground">SL <span className="font-mono font-semibold text-foreground">{agent.stopLossBps}bps</span></span>
        <span className="text-muted-foreground">TP <span className="font-mono font-semibold text-foreground">{agent.takeProfitBps ?? 50}bps</span></span>
        {agent.walletAddress && (
          <a href={`https://suiexplorer.com/address/${agent.walletAddress}?network=mainnet`}
            target="_blank" rel="noreferrer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors">
            Agent wallet <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>

      {/* ── Open Position (waterx-style) ── */}
      <Card
        data-testid="card-current-position"
        className={openTrade ? "border-primary/30 bg-primary/[0.02]" : ""}
      >
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-1.5">
            <Activity className={`h-3.5 w-3.5 ${openTrade ? "text-primary" : "text-muted-foreground"}`} />
            <span className={openTrade ? "text-foreground" : "text-muted-foreground"}>Open Position</span>
            {openTrade && (
              <Badge className={`text-[10px] ml-1 ${openTrade.side === "long" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-red-500/20 text-red-400 border-red-500/30"}`} variant="outline">
                {openTrade.side.toUpperCase()} · {openTrade.leverage}x
              </Badge>
            )}
          </CardTitle>
          {openTrade && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={closeMutation.isPending}
              onClick={() => closeMutation.mutate(agent.id)}
              data-testid="button-close-position"
            >
              <XCircle className="h-3.5 w-3.5" />
              {closeMutation.isPending ? "Closing…" : "Close Position"}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!openTrade ? (
            <p className="text-xs text-muted-foreground">No open position — engine is scanning for a breakout setup.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-x-4 gap-y-3 text-xs">
                <div>
                  <p className="text-muted-foreground mb-0.5">Entry Price</p>
                  <p className="font-mono font-semibold" data-testid="text-pos-entry">${fmt(openTrade.entryPrice)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Mark Price</p>
                  <p className="font-mono font-semibold" data-testid="text-pos-mark">
                    {currentPrice ? `$${currentPrice.toFixed(4)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Liq. Price</p>
                  <p className="font-mono font-semibold text-orange-400" data-testid="text-pos-liq">
                    {liqPrice ? `$${fmt(liqPrice)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Take Profit</p>
                  <p className="font-mono font-semibold text-emerald-400" data-testid="text-pos-tp">${fmt(openTrade.takeProfitPrice)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Stop Loss</p>
                  <p className="font-mono font-semibold text-red-400" data-testid="text-pos-sl">${fmt(openTrade.stopLossPrice)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Unrealized PnL</p>
                  <p className={`font-mono font-semibold ${pnlColor(unrealizedPnl)}`} data-testid="text-pos-upnl">
                    {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 3)} SUI` : "--"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Size</p>
                  <p className="font-mono" data-testid="text-pos-size">{openTrade.collateralSui} SUI × {openTrade.leverage}x</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Notional</p>
                  <p className="font-mono">{(openTrade.collateralSui * openTrade.leverage).toFixed(1)} SUI</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Age</p>
                  <p className="font-mono" data-testid="text-pos-age">
                    {posAge != null ? `${Math.floor(posAge / 60)}m ${posAge % 60}s` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Opened</p>
                  <p className="font-mono text-muted-foreground" data-testid="text-pos-opened">{fmtTs(openTrade.entryTs)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Entry Reason</p>
                  <p className="text-muted-foreground capitalize text-[10px]">{openTrade.entryReason?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Trend at Entry</p>
                  <p className={`capitalize text-[10px] font-medium ${
                    openTrade.trendBiasAtEntry === "bullish" ? "text-emerald-400" :
                    openTrade.trendBiasAtEntry === "bearish" ? "text-red-400" : "text-muted-foreground"
                  }`}>{openTrade.trendBiasAtEntry}</p>
                </div>
              </div>

              {/* Progress bar: distance to TP vs SL */}
              {currentPrice && (() => {
                const range = Math.abs(openTrade.takeProfitPrice - openTrade.stopLossPrice);
                const progress = openTrade.side === "long"
                  ? (currentPrice - openTrade.stopLossPrice) / range
                  : (openTrade.stopLossPrice - currentPrice) / range;
                const pct = Math.max(0, Math.min(1, progress)) * 100;
                return (
                  <div className="mt-3">
                    <div className="flex justify-between text-[9px] text-muted-foreground mb-1">
                      <span>SL ${fmt(openTrade.stopLossPrice)}</span>
                      <span className="font-medium">Progress to TP</span>
                      <span>TP ${fmt(openTrade.takeProfitPrice)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${pct > 60 ? "bg-emerald-400" : pct > 30 ? "bg-yellow-400" : "bg-red-400"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Trade History ── */}
      <Card data-testid="card-trade-history">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" />
            Trade History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {closedTrades.length === 0 ? (
            <p className="text-xs text-muted-foreground">No closed trades yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-3 font-medium">Time</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Side</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Entry</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Exit</th>
                    <th className="text-right py-1.5 pr-3 font-medium">PnL</th>
                    <th className="text-right py-1.5 pr-3 font-medium hidden md:table-cell">Lev</th>
                    <th className="text-left py-1.5 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map(t => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors" data-testid={`row-trade-${t.id}`}>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{fmtTs(t.entryTs)}</td>
                      <td className={`py-1.5 pr-3 font-semibold uppercase ${sideColor(t.side)}`}>{t.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.entryPrice)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.exitPrice)}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono font-semibold ${pnlColor(t.pnlSui)}`}>
                        {t.pnlSui != null ? `${t.pnlSui >= 0 ? "+" : ""}${fmt(t.pnlSui, 3)}` : "--"}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-muted-foreground hidden md:table-cell">{t.leverage}x</td>
                      <td className="py-1.5 text-muted-foreground capitalize">{t.exitReason?.replace(/_/g, " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Rewards tab ──────────────────────────────────────────────────────────────

function RewardsTab() {
  const account = useCurrentAccount();
  const wallet = account?.address ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: summary, isLoading } = useQuery<RewardSummary>({
    queryKey: ["/api/rewards/summary", wallet],
    queryFn: () => fetch(`/api/rewards/summary?userId=${encodeURIComponent(wallet)}`).then(r => r.json()),
    enabled: !!wallet,
    refetchInterval: 10000,
  });

  const claimAllMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/rewards/claim-all", { userId: wallet }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rewards/summary", wallet] });
      toast({ title: "All rewards claimed" });
    },
    onError: () => toast({ title: "Failed to claim", variant: "destructive" }),
  });

  const claimOneMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/rewards/${id}/claim`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rewards/summary", wallet] });
      toast({ title: "Reward claimed" });
    },
  });

  if (!wallet) return null;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-40" />
      </div>
    );
  }

  const totalPending = summary?.totalPending ?? 0;
  const totalClaimed = summary?.totalClaimed ?? 0;
  const totalEarned = summary?.totalEarned ?? 0;
  const pendingList = (summary?.rewards ?? []).filter(r => r.status === "pending");
  const claimedList = (summary?.rewards ?? []).filter(r => r.status === "claimed");

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Rewards</h2>
          <p className="text-xs text-muted-foreground">10% of winning trade PnL accumulates here</p>
        </div>
        {pendingList.length > 0 && (
          <Button
            size="sm"
            onClick={() => claimAllMutation.mutate()}
            disabled={claimAllMutation.isPending}
            data-testid="button-claim-all"
          >
            <Gift className="h-3.5 w-3.5 mr-1.5" />
            {claimAllMutation.isPending ? "Claiming…" : `Claim All (${pendingList.length})`}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card data-testid="stat-pending">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
              <Clock className="h-4.5 w-4.5 text-yellow-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Pending</p>
              <p className="text-xl font-bold font-mono text-yellow-400" data-testid="text-pending-amount">{totalPending.toFixed(4)} SUI</p>
              <p className="text-[10px] text-muted-foreground">{pendingList.length} reward{pendingList.length !== 1 ? "s" : ""}</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-claimed">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
              <CheckCircle className="h-4.5 w-4.5 text-emerald-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Claimed</p>
              <p className="text-xl font-bold font-mono text-emerald-400" data-testid="text-claimed-amount">{totalClaimed.toFixed(4)} SUI</p>
              <p className="text-[10px] text-muted-foreground">{claimedList.length} claimed</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-total">
          <CardContent className="pt-4 pb-3 flex items-start gap-3">
            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <TrendingUp className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Earned</p>
              <p className="text-xl font-bold font-mono" data-testid="text-total-earned">{totalEarned.toFixed(4)} SUI</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {totalPending > 0 && (
        <Card className="border-primary/20 bg-primary/5" data-testid="card-claim-hero">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <Coins className="h-6 w-6 text-primary" />
              <div>
                <p className="font-bold font-mono">{totalPending.toFixed(4)} SUI ready to claim</p>
                <p className="text-xs text-muted-foreground">From {pendingList.length} winning trade{pendingList.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            <Button size="sm" onClick={() => claimAllMutation.mutate()} disabled={claimAllMutation.isPending} data-testid="button-claim-hero">
              Claim All
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Reward History</CardTitle>
        </CardHeader>
        <CardContent>
          {(summary?.rewards ?? []).length === 0 ? (
            <div className="text-center py-10">
              <Gift className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No rewards yet — activate your agent to start earning</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(summary?.rewards ?? []).map(r => (
                <div key={r.id} className="flex items-center justify-between text-xs py-2 border-b border-border/50 last:border-0" data-testid={`row-reward-${r.id}`}>
                  <div>
                    <span className="font-mono font-semibold text-emerald-400">+{r.amount.toFixed(4)} SUI</span>
                    <span className="text-muted-foreground ml-2">{fmtDate(r.createdAt)}</span>
                  </div>
                  {r.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2"
                      onClick={() => claimOneMutation.mutate(r.id)}
                      disabled={claimOneMutation.isPending}
                      data-testid={`button-claim-${r.id}`}
                    >
                      Claim
                    </Button>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">Claimed {fmtDate(r.claimedAt)}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Engine tab (existing monitoring) ─────────────────────────────────────────

function EngineTab() {
  const qc = useQueryClient();
  const livePrice = useLivePrice();
  const wsPrice = livePrice?.blended ?? livePrice?.pyth?.price ?? livePrice?.price ?? null;
  const { data: httpPriceData } = useQuery<{ blended?: number; pyth?: { price: number } }>({
    queryKey: ["/api/market/price"],
    refetchInterval: 3000,
    enabled: wsPrice === null,
  });
  const currentPrice = wsPrice ?? (httpPriceData?.blended ?? httpPriceData?.pyth?.price ?? null);

  const { data: engineData, isLoading: engineLoading } = useQuery<{ state: EngineState; scanDecision: ScanDecision | null }>({
    queryKey: ["/api/engine/state"],
    refetchInterval: 3000,
  });

  const { data: trades = [], isLoading: tradesLoading } = useQuery<TradeRecord[]>({
    queryKey: ["/api/engine/trades"],
    refetchInterval: 5000,
  });

  const { data: summary } = useQuery<{ total: number; wins: number; losses: number; winRate: number; pnlSui: number; avgWinner: number; avgLoser: number }>({
    queryKey: ["/api/engine/summary"],
    refetchInterval: 10000,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiRequest("POST", "/api/engine/toggle", { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/engine/state"] }),
  });

  const engineState = engineData?.state;
  const scanDecision = engineData?.scanDecision;
  const currentTrade = engineState?.currentTradeId ? trades.find(t => t.id === engineState.currentTradeId) : null;
  const closedTrades = trades.filter(t => t.status === "closed").slice(0, 20);
  const nowTs = Date.now();
  const inCooldown = engineState?.cooldownUntilTs && engineState.cooldownUntilTs > nowTs;
  const cooldownRemainingS = inCooldown ? Math.ceil((engineState!.cooldownUntilTs! - nowTs) / 1000) : 0;

  const unrealizedPnl = currentTrade && currentPrice
    ? (() => {
        const raw = currentTrade.side === "long" ? currentPrice - currentTrade.entryPrice : currentTrade.entryPrice - currentPrice;
        return currentTrade.collateralSui * currentTrade.leverage * (raw / currentTrade.entryPrice);
      })()
    : null;

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Breakout Engine</h2>
          <p className="text-xs text-muted-foreground">SUI-USDC Perpetual · Typus Finance · 30x</p>
        </div>
        <div className="flex items-center gap-2">
          {currentPrice && (
            <Badge variant="outline" className="font-mono text-xs" data-testid="badge-current-price">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1.5" />
              ${currentPrice.toFixed(4)}
            </Badge>
          )}
          <Button
            data-testid="button-engine-toggle"
            size="sm"
            variant={engineState?.isEnabled ? "destructive" : "default"}
            disabled={toggleMutation.isPending || engineLoading}
            onClick={() => toggleMutation.mutate(!engineState?.isEnabled)}
          >
            {engineState?.isEnabled ? "Stop Engine" : "Start Engine"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-engine-status">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Engine Status</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">State</span>
              <Badge variant="outline" className={engineState?.isEnabled ? "text-emerald-400 border-emerald-400/30" : "text-muted-foreground"} data-testid="badge-engine-state">
                {engineState?.isEnabled ? "RUNNING" : "STOPPED"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Daily PnL</span>
              <span className={`font-mono font-semibold ${pnlColor(engineState?.dailyRealizedPnlSui)}`} data-testid="text-daily-pnl">
                {engineState ? `${engineState.dailyRealizedPnlSui >= 0 ? "+" : ""}${fmt(engineState.dailyRealizedPnlSui, 3)} SUI` : "--"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Consec. Losses</span>
              <span className={`font-mono ${(engineState?.consecutiveLosses ?? 0) >= 3 ? "text-orange-400" : ""}`} data-testid="text-consec-losses">
                {engineState?.consecutiveLosses ?? "--"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cooldown</span>
              <span className="font-mono" data-testid="text-cooldown">{inCooldown ? `${cooldownRemainingS}s` : "–"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last scan</span>
              <span className="font-mono" data-testid="text-last-scan">{fmtTs(engineState?.lastScanTs)}</span>
            </div>
            {engineState?.lastError && <div className="text-red-400 text-[10px] break-all">{engineState.lastError}</div>}
          </CardContent>
        </Card>

        <Card data-testid="card-regime-filter">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Last Scan</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!scanDecision ? (
              <p className="text-muted-foreground">Waiting for first scan…</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Regime</span>
                  <Badge variant="outline" className={scanDecision.regime.tradeable ? "text-emerald-400 border-emerald-400/30" : "text-orange-400 border-orange-400/30"} data-testid="badge-regime">
                    {scanDecision.regime.tradeable ? "TRADEABLE" : "BLOCKED"}
                  </Badge>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">ATR ratio</span><span className="font-mono" data-testid="text-atr-ratio">{fmt(scanDecision.regime.atrRatio, 2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Vol ratio</span><span className="font-mono" data-testid="text-vol-ratio">{fmt(scanDecision.regime.volumeRatio, 2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Trend bias</span><span className="font-mono capitalize">{scanDecision.regime.trendBias}</span></div>
                {scanDecision.regime.blockReason && <div className="text-orange-400 text-[10px]">{scanDecision.regime.blockReason}</div>}
                {!scanDecision.decision.shouldTrade
                  ? <div className="text-muted-foreground text-[10px]">{scanDecision.decision.reason}</div>
                  : <div className={`font-semibold uppercase ${sideColor(scanDecision.decision.side as any)}`} data-testid="text-signal">▲ {scanDecision.decision.side?.toUpperCase()} SIGNAL</div>}
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-current-position">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Current Position</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!currentTrade ? (
              <p className="text-muted-foreground">No open position</p>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-muted-foreground">Side</span><span className={`font-semibold uppercase font-mono ${sideColor(currentTrade.side)}`}>{currentTrade.side}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono">${fmt(currentTrade.entryPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="font-mono text-emerald-400">${fmt(currentTrade.takeProfitPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="font-mono text-red-400">${fmt(currentTrade.stopLossPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span className="font-mono">{currentTrade.collateralSui} SUI × {currentTrade.leverage}x</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Unreal. PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(unrealizedPnl)}`}>
                    {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 3)} SUI` : "--"}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-metrics">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Session Metrics</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {!summary ? (
              <p className="text-muted-foreground">No trades yet</p>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-muted-foreground">Total trades</span><span className="font-mono">{summary.total}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Win rate</span><span className="font-mono">{summary.total ? `${(summary.winRate * 100).toFixed(1)}%` : "--"}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">W / L</span>
                  <span className="font-mono"><span className="text-emerald-400">{summary.wins}</span> / <span className="text-red-400">{summary.losses}</span></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total PnL</span>
                  <span className={`font-mono font-semibold ${pnlColor(summary.pnlSui)}`}>{`${summary.pnlSui >= 0 ? "+" : ""}${fmt(summary.pnlSui, 3)} SUI`}</span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg winner</span><span className="font-mono text-emerald-400">+{fmt(summary.avgWinner, 3)} SUI</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg loser</span><span className="font-mono text-red-400">{fmt(summary.avgLoser, 3)} SUI</span></div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-recent-trades">
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">All Recent Trades</CardTitle></CardHeader>
        <CardContent>
          {tradesLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : closedTrades.length === 0 ? (
            <p className="text-xs text-muted-foreground">No closed trades yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-3 font-medium">Time</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Side</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Entry</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Exit</th>
                    <th className="text-right py-1.5 pr-3 font-medium">PnL (SUI)</th>
                    <th className="text-right py-1.5 pr-3 font-medium">PnL (bps)</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Reason</th>
                    <th className="text-right py-1.5 font-medium">ATR</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map(t => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors" data-testid={`row-trade-global-${t.id}`}>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{fmtTs(t.entryTs)}</td>
                      <td className={`py-1.5 pr-3 font-semibold uppercase ${sideColor(t.side)}`}>{t.side}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.entryPrice)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">${fmt(t.exitPrice)}</td>
                      <td className={`py-1.5 pr-3 text-right font-mono font-semibold ${pnlColor(t.pnlSui)}`}>
                        {t.pnlSui != null ? `${t.pnlSui >= 0 ? "+" : ""}${fmt(t.pnlSui, 3)}` : "--"}
                      </td>
                      <td className={`py-1.5 pr-3 text-right font-mono ${pnlColor(t.pnlBps)}`}>
                        {t.pnlBps != null ? `${t.pnlBps >= 0 ? "+" : ""}${fmt(t.pnlBps, 1)}` : "--"}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground capitalize">{t.exitReason?.replace(/_/g, " ")}</td>
                      <td className="py-1.5 text-right font-mono text-muted-foreground">{fmt(t.atrRatioAtEntry, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const account = useCurrentAccount();

  return (
    <Tabs defaultValue="engine" className="flex flex-col h-full">
      <div className="border-b px-4 pt-1">
        <TabsList className="h-9" data-testid="tabs-main">
          <TabsTrigger value="my-agent" className="text-xs" data-testid="tab-my-agent">My Agent</TabsTrigger>
          <TabsTrigger value="rewards" className="text-xs" data-testid="tab-rewards">Rewards</TabsTrigger>
          <TabsTrigger value="engine" className="text-xs" data-testid="tab-engine">Engine</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="my-agent" className="mt-0 flex-1 overflow-y-auto">
        <WalletGate>
          <MyAgentTab />
        </WalletGate>
      </TabsContent>

      <TabsContent value="rewards" className="mt-0 flex-1 overflow-y-auto">
        <WalletGate>
          <RewardsTab />
        </WalletGate>
      </TabsContent>

      <TabsContent value="engine" className="mt-0 flex-1 overflow-y-auto">
        <EngineTab />
      </TabsContent>
    </Tabs>
  );
}
