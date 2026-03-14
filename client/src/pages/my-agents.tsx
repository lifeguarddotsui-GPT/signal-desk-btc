import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { usePageSEO } from "@/lib/seo";
import { useLivePrice, useWS } from "@/lib/ws-context";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { waitForFinalized } from "@/lib/tx-verify";
import type { AgentWithSignalAgent, Signal, Position, InstructionBundleRecord } from "@shared/schema";
import { PROTOCOL_FEE_ADDRESS } from "@shared/schema";
import {
  Bot,
  Brain,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle,
  XCircle,
  Signal as SignalIcon,
  ExternalLink,
  Wallet,
  Shield,
  Zap,
  Copy,
  ArrowDownToLine,
  Loader2,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Lock,
  Unlock,
  Package,
  Clock,
  PlayCircle,
  CheckCircle2,
  XOctagon,
  Timer,
  RefreshCw,
  X,
  Eye,
  FileText,
  ChevronDown,
  Coins,
  Power,
  PiggyBank,
  Fuel,
  Briefcase,
  Info,
  ShieldCheck,
  ShieldAlert,
  Trash2,
} from "lucide-react";

class PageErrorBoundary extends Component<{ children: ReactNode; label?: string }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(e: Error) {
    return { hasError: true, error: e.message };
  }
  componentDidCatch(e: Error, info: { componentStack: string }) {
    console.error(`[PageErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, e.message, info.componentStack?.slice(0, 400));
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-center">
          <p className="text-[11px] text-red-400 font-medium mb-1">
            {this.props.label ? `${this.props.label} panel` : "Section"} encountered an error
          </p>
          <p className="text-[10px] text-muted-foreground mb-2">{this.state.error.slice(0, 120)}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: "" })}
            className="text-[10px] px-2 py-1 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatDuration(from: Date): string {
  const secs = Math.floor((Date.now() - from.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function fmtSui(val: number): string {
  const abs = Math.abs(val);
  if (abs === 0) return "0.00";
  if (abs < 0.01) return val.toFixed(4);
  if (abs < 1) return val.toFixed(3);
  return val.toFixed(2);
}

function useStableValue(rawValue: number, isSettling: boolean): number {
  const stableRef = useRef(rawValue);
  const confirmRef = useRef(0);

  if (!isSettling) {
    stableRef.current = rawValue;
    confirmRef.current = 0;
    return rawValue;
  }

  if (rawValue === 0 && stableRef.current === 0) return 0;

  if (rawValue === 0) {
    confirmRef.current++;
    if (confirmRef.current >= 4) {
      stableRef.current = 0;
      confirmRef.current = 0;
      return 0;
    }
    return stableRef.current;
  }

  const pctDiff = stableRef.current > 0
    ? Math.abs(rawValue - stableRef.current) / stableRef.current
    : 1;

  if (pctDiff <= 0.008) {
    confirmRef.current = 0;
    return stableRef.current;
  }

  confirmRef.current++;
  if (confirmRef.current >= 3) {
    stableRef.current = rawValue;
    confirmRef.current = 0;
    return rawValue;
  }

  return stableRef.current;
}

const VENUE_LABELS: Record<string, string> = {
  typus: "Typus Perps",
};

const SIGNAL_MODES = [
  { value: "AUTO", label: "Auto", desc: "Engine picks mode per conditions", color: "bg-muted/40 text-muted-foreground border-border/30" },
  { value: "AGGRESSIVE", label: "Aggressive", desc: "Lower thresholds, more trades", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  { value: "PRECISION", label: "Precision", desc: "Higher thresholds, fewer trades", color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
] as const;

function SignalModeToggle({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const currentMode = agent.signalMode || "AUTO";
  const [optimisticMode, setOptimisticMode] = useState<string | null>(null);
  const displayMode = optimisticMode || currentMode;

  useEffect(() => { setOptimisticMode(null); }, [currentMode]);

  const updateMode = useMutation({
    mutationFn: async (mode: string) => {
      const wa = account?.address;
      if (!wa) throw new Error("Connect your wallet first");
      setOptimisticMode(mode);
      await apiRequest("PATCH", `/api/agents/${agent.id}?wallet=${wa}`, { signalMode: mode });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Signal mode updated" });
    },
    onError: (err: any) => {
      setOptimisticMode(null);
      toast({ title: "Failed to update mode", description: err.message, variant: "destructive" });
    },
  });

  const walletConnected = !!account?.address;

  return (
    <div className="space-y-1 pt-1" data-testid="signal-mode-toggle">
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] text-muted-foreground uppercase shrink-0 mr-1">Signal Mode</span>
        {SIGNAL_MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => { if (displayMode !== m.value && walletConnected) updateMode.mutate(m.value); }}
            disabled={updateMode.isPending || !walletConnected}
            className={`px-2 py-1 rounded text-[9px] font-medium border transition-all ${!walletConnected ? "opacity-40 cursor-not-allowed bg-muted/5 text-muted-foreground/30 border-border/10" : displayMode === m.value ? m.color + " ring-1 ring-primary/30" : "bg-muted/10 text-muted-foreground/50 border-border/10 hover:border-border/30 hover:bg-muted/20"}`}
            title={walletConnected ? m.desc : "Connect wallet to change mode"}
            data-testid={`button-mode-${m.value.toLowerCase()}`}
          >
            {updateMode.isPending && optimisticMode === m.value ? "..." : m.label}
          </button>
        ))}
      </div>
      {!walletConnected && (
        <p className="text-[8px] text-amber-400/70 flex items-center gap-1">
          <Wallet className="h-2.5 w-2.5" /> Connect wallet to change signal mode
        </p>
      )}
    </div>
  );
}

const RETENTION_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 50];

function RetentionPctControl({ agent }: { agent: AgentWithSignalAgent }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const currentPct = agent.savingsSplitPct ?? 10;
  const [optimisticPct, setOptimisticPct] = useState<number | null>(null);
  const displayPct = optimisticPct ?? currentPct;

  useEffect(() => { setOptimisticPct(null); }, [currentPct]);

  const updatePct = useMutation({
    mutationFn: async (pct: number) => {
      const wa = account?.address;
      if (!wa) throw new Error("Connect your wallet first");
      setOptimisticPct(pct);
      await apiRequest("PATCH", `/api/agents/${agent.id}?wallet=${wa}`, { savingsSplitPct: pct });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Savings rate updated" });
    },
    onError: (err: any) => {
      setOptimisticPct(null);
      toast({ title: "Failed to update savings rate", description: err.message, variant: "destructive" });
    },
  });

  const walletConnected = !!account?.address;

  return (
    <div className="space-y-1 pt-1" data-testid="retention-pct-control">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[8px] text-muted-foreground uppercase shrink-0 mr-1 flex items-center gap-1">
          <PiggyBank className="h-2.5 w-2.5" /> Profit Savings
        </span>
        {RETENTION_OPTIONS.map((pct) => (
          <button
            key={pct}
            onClick={() => { if (displayPct !== pct && walletConnected) updatePct.mutate(pct); }}
            disabled={updatePct.isPending || !walletConnected}
            className={`px-1.5 py-0.5 rounded text-[9px] font-medium border transition-all ${!walletConnected ? "opacity-40 cursor-not-allowed bg-muted/5 text-muted-foreground/30 border-border/10" : displayPct === pct ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 ring-1 ring-emerald-500/20" : "bg-muted/10 text-muted-foreground/50 border-border/10 hover:border-border/30 hover:bg-muted/20"}`}
            title={walletConnected ? `Transfer ${pct}% of profit to savings wallet after each winning trade` : "Connect wallet to change savings"}
            data-testid={`button-retention-${pct}`}
          >
            {updatePct.isPending && optimisticPct === pct ? "..." : `${pct}%`}
          </button>
        ))}
      </div>
      <p className="text-[7px] text-muted-foreground/60">
        Percentage of realized profit transferred on-chain to savings wallet after each winning trade
      </p>
    </div>
  );
}

function isValidTxDigest(digest: string): boolean {
  return /^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(digest);
}

function TxLink({ txDigest, label }: { txDigest: string | null | undefined; label?: string }) {
  if (!txDigest) return null;
  const syntheticLabels: Record<string, { text: string; icon: "settled" | "liquidated" }> = {
    "liquidated_onchain": { text: "Liquidated", icon: "liquidated" },
    "settled_onchain": { text: "Settled", icon: "settled" },
    "prior_fill": { text: "Filled", icon: "settled" },
    "closed_externally": { text: "Settled", icon: "settled" },
  };
  const synthetic = syntheticLabels[txDigest];
  if (synthetic) {
    const isLiq = synthetic.icon === "liquidated";
    return (
      <span className={`flex items-center gap-1 text-[9px] ${isLiq ? "text-red-400" : "text-teal-400"}`} data-testid={isLiq ? "text-tx-liquidated" : "text-tx-settled"}>
        {isLiq ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> : <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />}
        {label ? `${label}: ${synthetic.text}` : synthetic.text}
      </span>
    );
  }
  if (!isValidTxDigest(txDigest)) {
    return (
      <span className="flex items-center gap-1 text-[9px] text-teal-400" data-testid="text-tx-settled">
        <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
        {label ? `${label}: Settled` : "Settled"}
      </span>
    );
  }
  return (
    <a
      href={`https://suivision.xyz/txblock/${txDigest}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 text-[9px] text-emerald-500 hover:underline"
      data-testid="link-tx-onchain"
    >
      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
      {label ? `${label}` : txDigest.slice(0, 12) + "..."}
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
    }
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} className="text-muted-foreground hover:text-foreground transition-colors" data-testid="button-copy">
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const THINKING_PHRASES = [
  "Scanning market microstructure...",
  "Cross-referencing RSI divergence signals...",
  "Evaluating momentum indicators...",
  "Analyzing order flow patterns...",
  "Computing Connors RSI confluence...",
  "Checking DEMA/TEMA crossover signals...",
  "Measuring volatility regime...",
  "Scoring condition matrix...",
  "Validating signal strength margin...",
  "Assessing trend direction consensus...",
];

function SignalReadinessGauge({ readiness, triton }: { readiness: any; triton: any }) {
  if (!readiness || !triton || triton.side === "NONE") return null;

  const scorePct = readiness.scoreReadinessPct as number;
  const rrPct = readiness.rrReadinessPct as number;
  const score = readiness.score as number;
  const weakScore = readiness.weakScore as number;
  const currentRr = readiness.currentRr as number;
  const minRr = readiness.minRr as number;
  const blocking = readiness.blockingChecks as string[];
  const isScoreReady = scorePct >= 100;
  const isRrReady = rrPct >= 100;
  const isFullyReady = isScoreReady && isRrReady && !readiness.htfConflict;

  const scoreColor = isScoreReady
    ? "bg-teal-500"
    : scorePct >= 80
    ? "bg-amber-400"
    : scorePct >= 50
    ? "bg-amber-500/70"
    : "bg-muted-foreground/30";

  const rrColor = isRrReady ? "bg-teal-500" : rrPct >= 70 ? "bg-amber-400" : "bg-muted-foreground/30";

  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${
      isFullyReady
        ? "border-teal-500/40 bg-teal-500/5"
        : "border-border/30 bg-card/40"
    }`} data-testid="signal-readiness-gauge">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          <Activity className="h-2.5 w-2.5" />
          Order Readiness
        </span>
        <div className="flex items-center gap-1.5">
          {triton?.activeMode && (
            <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-muted/60 text-muted-foreground border border-border/20">
              {triton.activeMode}
            </span>
          )}
          {triton?.regime && (
            <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-muted/60 text-muted-foreground border border-border/20">
              {triton.regime}
            </span>
          )}
          {isFullyReady ? (
            <span className="text-[9px] font-bold text-teal-400 animate-pulse">● READY</span>
          ) : (
            <span className="text-[9px] text-muted-foreground font-mono">
              {Math.min(scorePct, rrPct)}%
            </span>
          )}
        </div>
      </div>

      {/* Score bar */}
      <div className="space-y-0.5">
        <div className="flex justify-between items-center">
          <span className="text-[8px] text-muted-foreground">Score</span>
          <span className={`text-[8px] font-mono font-bold ${isScoreReady ? "text-teal-400" : "text-muted-foreground"}`}>
            {score} / {weakScore}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${scoreColor}`}
            style={{ width: `${scorePct}%` }}
          />
        </div>
      </div>

      {/* RR bar */}
      <div className="space-y-0.5">
        <div className="flex justify-between items-center">
          <span className="text-[8px] text-muted-foreground">Risk/Reward</span>
          <span className={`text-[8px] font-mono font-bold ${isRrReady ? "text-teal-400" : "text-muted-foreground"}`}>
            {currentRr.toFixed(2)} / {minRr.toFixed(1)} min
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${rrColor}`}
            style={{ width: `${rrPct}%` }}
          />
        </div>
      </div>

      {/* Blocking reasons */}
      {blocking.length > 0 && (
        <div className="space-y-0.5 pt-0.5 border-t border-border/20">
          {blocking.map((reason: string, i: number) => (
            <div key={i} className="flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-amber-400/80 shrink-0" />
              <span className="text-[8px] text-amber-400/80 font-mono">{reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveThinkingBanner({ reasoning }: { reasoning: any }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const phraseTimer = setInterval(() => setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length), 3500);
    const dotTimer = setInterval(() => setDots(d => d >= 3 ? 1 : d + 1), 600);
    return () => { clearInterval(phraseTimer); clearInterval(dotTimer); };
  }, []);

  const side = reasoning?.side;
  const signal = reasoning?.signal || "ANALYZING";
  const longScore = reasoning?.longScore ?? 0;
  const shortScore = reasoning?.shortScore ?? 0;
  const total = longScore + shortScore;
  const longPct = total === 0 ? 50 : Math.round((longScore / total) * 100);

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3" data-testid="active-thinking-banner">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative">
          <Brain className="h-4 w-4 text-primary animate-pulse" />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
        </div>
        <p className="text-[10px] text-muted-foreground">
          {THINKING_PHRASES[phraseIdx]}{".".repeat(dots)}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="h-2 rounded-full bg-muted overflow-hidden flex">
            {total === 0 ? (
              <div className="h-full w-full bg-muted-foreground/20" />
            ) : (
              <>
                <div className="h-full bg-emerald-500/70 transition-all duration-700" style={{ width: `${longPct}%` }} />
                <div className="h-full bg-red-500/70 transition-all duration-700" style={{ width: `${100 - longPct}%` }} />
              </>
            )}
          </div>
          <div className="flex justify-between mt-0.5">
            <span className="text-[8px] font-mono text-emerald-500">LONG {longScore}</span>
            <span className="text-[8px] font-mono text-red-500">SHORT {shortScore}</span>
          </div>
        </div>
        <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase font-mono ${
          side === "long" ? "bg-emerald-500/20 text-emerald-400" :
          side === "short" ? "bg-red-500/20 text-red-400" :
          "bg-muted text-muted-foreground"
        }`} data-testid="text-signal-decision">
          {signal}
        </div>
      </div>
    </div>
  );
}

function ThinkingProcess({ agentId, reasoning }: { agentId: string; reasoning: any }) {
  if (!reasoning) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="relative mb-3">
          <Brain className="h-10 w-10 text-muted-foreground/40" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-primary/30 animate-ping" />
          </span>
        </div>
        <p className="text-xs text-muted-foreground">Waiting for signal analysis...</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">The sub-agent will analyze when the market engine ticks</p>
      </div>
    );
  }

  const sideColor = reasoning.side === "long" ? "text-emerald-500" : reasoning.side === "short" ? "text-red-500" : "text-muted-foreground";
  const SideIcon = reasoning.side === "long" ? TrendingUp : reasoning.side === "short" ? TrendingDown : Minus;
  const metConditions = reasoning.conditions?.filter((c: any) => c.met) || [];
  const totalConditions = reasoning.conditions?.length || 7;

  return (
    <div className="space-y-3" data-testid="agent-thinking-process">
      <ActiveThinkingBanner reasoning={reasoning} />

      <SignalReadinessGauge readiness={reasoning.readiness} triton={reasoning.triton} />

      <div className="flex items-center gap-3 bg-card/60 rounded-lg p-2.5 border border-border/30">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
          reasoning.side === "long" ? "bg-emerald-500/15 ring-1 ring-emerald-500/30" :
          reasoning.side === "short" ? "bg-red-500/15 ring-1 ring-red-500/30" :
          "bg-muted ring-1 ring-border"
        }`}>
          <SideIcon className={`h-4 w-4 ${sideColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold uppercase ${sideColor}`}>{reasoning.signal}</span>
            <Badge variant="outline" className="text-[8px]">{metConditions.length}/{totalConditions}</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{reasoning.reason}</p>
        </div>
      </div>

      {reasoning.conditions && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Activity className="h-3 w-3" />
            Conditions ({metConditions.length}/{totalConditions} met)
          </p>
          <div className="grid gap-0.5">
            {reasoning.conditions.map((cond: any, i: number) => (
              <div key={i} className={`flex items-center gap-2 rounded px-2.5 py-1.5 ${
                cond.met ? "bg-emerald-500/5 border border-emerald-500/10" : "bg-card/30"
              }`}>
                {cond.met ? (
                  <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
                ) : (
                  <XCircle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-[10px] font-medium truncate ${cond.met ? "text-foreground" : "text-muted-foreground/60"}`}>{cond.name}</p>
                </div>
                <span className={`text-[8px] font-mono font-bold shrink-0 ${
                  cond.direction === "long" ? "text-emerald-500" :
                  cond.direction === "short" ? "text-red-500" :
                  "text-muted-foreground/50"
                }`}>
                  {(cond.direction || "—").toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {reasoning.indicators && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <SignalIcon className="h-3 w-3" />
            Indicators
          </p>
          <div className="grid grid-cols-2 gap-0.5">
            {Object.entries(reasoning.indicators).map(([key, val]: [string, any]) => {
              let displayVal: string;
              if (typeof val === "number") {
                displayVal = val.toFixed(2);
              } else if (val && typeof val === "object") {
                if ("bullish" in val) {
                  displayVal = val.bullish ? "Bullish" : val.bearish ? "Bearish" : "None";
                } else {
                  displayVal = JSON.stringify(val);
                }
              } else {
                displayVal = String(val);
              }
              const isBullish = displayVal === "Bullish" || displayVal === "up";
              const isBearish = displayVal === "Bearish" || displayVal === "down";

              return (
                <div key={key} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-card/30">
                  <span className="text-[9px] text-muted-foreground uppercase">{key}</span>
                  <span className={`text-[11px] font-mono font-bold ${
                    isBullish ? "text-emerald-500" : isBearish ? "text-red-500" : ""
                  }`}>{displayVal}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ClosePositionButton({ agentId, positionId, side, sizeSui }: { agentId: string; positionId: string; side: string; sizeSui: number }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [confirming, setConfirming] = useState(false);

  const closeMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agentId}/close-position/${positionId}${walletParam}`);
      return res.json();
    },
    onSuccess: (data) => {
      const pnlStr = data.pnl >= 0 ? `+${data.pnl.toFixed(4)}` : data.pnl.toFixed(4);
      const txInfo = data.txDigest ? ` | Tx: ${data.txDigest.slice(0, 12)}...` : "";
      toast({ title: "Position closed", description: `${side.toUpperCase()} ${sizeSui.toFixed(2)} SUI closed. PnL: ${pnlStr} SUI${txInfo}` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "positions"] });
      setConfirming(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to close position", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="destructive"
          onClick={() => closeMutation.mutate()}
          disabled={closeMutation.isPending}
          className="text-[9px] h-6 px-2"
          data-testid={`button-confirm-close-${positionId}`}
        >
          {closeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-[9px] h-6 px-1" data-testid={`button-cancel-close-${positionId}`}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setConfirming(true)}
      disabled={!account?.address}
      className="text-[9px] h-6 px-2"
      title={!account?.address ? "Connect wallet to close" : "Close this position on-chain"}
      data-testid={`button-close-position-${positionId}`}
    >
      <X className="h-3 w-3 mr-0.5" />Close
    </Button>
  );
}

function CloseAllButton({ agentId, openCount }: { agentId: string; openCount: number }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [confirming, setConfirming] = useState(false);

  const closeAllMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agentId}/close-all-positions${walletParam}`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Close all initiated",
        description: data.message || `Closed ${data.closedPositions} position(s).`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "positions"] });
      setConfirming(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to close positions", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  if (openCount === 0) return null;

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-destructive mr-1">Close all {openCount}?</span>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => closeAllMutation.mutate()}
          disabled={closeAllMutation.isPending}
          className="text-[9px] h-6 px-2"
          data-testid="button-confirm-close-all"
        >
          {closeAllMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-[9px] h-6 px-1" data-testid="button-cancel-close-all">
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setConfirming(true)}
      disabled={!account?.address || closeAllMutation.isPending}
      className="text-[9px] h-6 px-2 text-destructive border-destructive/30 hover:bg-destructive/10"
      title={!account?.address ? "Connect wallet to close all" : `Close all ${openCount} open position(s)`}
      data-testid="button-close-all"
    >
      <XOctagon className="h-3 w-3 mr-0.5" />Close All
    </Button>
  );
}

function CancelOrderButton({ agentId, orderId, collateral }: { agentId: string; orderId: string; collateral: number }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [confirming, setConfirming] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agentId}/cancel-order/${orderId}${walletParam}`);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.alreadyGone) {
        toast({ title: "Order already resolved", description: data.message || `Order #${orderId} no longer exists on Typus.` });
      } else {
        const txInfo = data.txDigest ? ` | Tx: ${data.txDigest.slice(0, 12)}...` : "";
        toast({ title: "Order cancelled", description: `Order #${orderId} cancelled. ${collateral.toFixed(2)} SUI returned.${txInfo}` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "positions"] });
      setConfirming(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel order", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="destructive"
          onClick={() => cancelMutation.mutate()}
          disabled={cancelMutation.isPending}
          className="text-[9px] h-6 px-2"
          data-testid={`button-confirm-cancel-order-${orderId}`}
        >
          {cancelMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-[9px] h-6 px-1" data-testid={`button-dismiss-cancel-${orderId}`}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setConfirming(true)}
      disabled={!account?.address}
      className="text-[9px] h-6 px-2 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
      title={!account?.address ? "Connect wallet to cancel" : "Cancel this unfilled order and recover collateral"}
      data-testid={`button-cancel-order-${orderId}`}
    >
      <X className="h-3 w-3 mr-0.5" />Cancel
    </Button>
  );
}

type ChainTrade = {
  openDigest: string;
  closeDigest: string | null;
  collateral: number;
  returned: number;
  pnlSui: number;
  outcome: "win" | "loss" | "liquidated" | "cancelled" | "open" | "pending_order";
  openTimestamp: string | null;
  closeTimestamp: string | null;
};

function PositionsPanel({ positions: parentPositions, livePrice: parentLivePrice, leverage, agentId, chainTrades, pendingOrders, untrackedPositions: parentUntracked, stopLossBps, takeProfitBps }: { positions: Position[]; livePrice: number; leverage: number; agentId: string; chainTrades?: ChainTrade[]; pendingOrders?: Array<{ orderId: string; collateral: number; direction: string; isStopOrder?: boolean }>; untrackedPositions?: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }>; stopLossBps?: number; takeProfitBps?: number }) {
  const { subscribe } = useWS();
  const { data: fastPositions } = useQuery<{
    positions: Position[];
    untrackedOnChainPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }>;
    liveSuiPrice: number;
    pendingOrders: Array<{ orderId: string; collateral: number; direction: string; isStopOrder?: boolean }>;
  }>({
    queryKey: ["/api/agents", agentId, "positions"],
    refetchInterval: 3000,
    staleTime: 2500,
  });

  useEffect(() => {
    const unsub = subscribe("positions:updated", (data: any) => {
      if (data?.agentId === agentId) {
        queryClient.invalidateQueries({ queryKey: ["/api/agents", agentId, "positions"] });
      }
    });
    return unsub;
  }, [agentId, subscribe]);

  // Sticky cache: keeps positions visible across brief refetch gaps (prevents flicker during open→close transition)
  const positionCacheRef = useRef<Map<string, Position>>(new Map());

  // Fast-poll returns ALL positions (open and closed). Include all of them to prevent the gap where
  // a position transitions from open → closed but the slower activity endpoint hasn't updated yet.
  const fastAll = fastPositions?.positions || [];
  if (fastAll.length > 0) {
    for (const p of fastAll) {
      positionCacheRef.current.set(p.id, p);
    }
  }

  const fastIds = new Set(fastAll.map(p => p.id));

  // If fast-poll temporarily returned empty (network gap), recover open positions from cache
  const cachedOpenGap: Position[] = fastPositions && fastAll.length === 0
    ? Array.from(positionCacheRef.current.values()).filter(p => p.status === "open" || p.status === "pending_open")
    : [];

  // Parent fills in closed positions not covered by the fast-poll
  const parentClosed = (parentPositions || []).filter(
    p => !fastIds.has(p.id) && p.status === "closed" && p.closeTxDigest !== "cancelled_unfilled"
  );

  const positions = fastPositions
    ? [...fastAll, ...cachedOpenGap, ...parentClosed]
    : (parentPositions || []);

  const livePrice = fastPositions?.liveSuiPrice ?? parentLivePrice;
  const untrackedPositions = fastPositions?.untrackedOnChainPositions ?? parentUntracked;

  const hasPositions = (positions && positions.length > 0) || (untrackedPositions && untrackedPositions.length > 0);
  const closedChainTrades = (chainTrades || []).filter(t => t.outcome !== "open" && t.outcome !== "cancelled" && t.outcome !== "pending_order");
  const pendingChainTrades = (chainTrades || []).filter(t => t.outcome === "pending_order");
  const apiPendingOrders = pendingOrders && pendingOrders.length > 0 ? pendingOrders : [];
  const chainFallbackOrders = apiPendingOrders.length === 0 ? pendingChainTrades.map((t, i) => ({
    orderId: `chain-${i}`,
    collateral: t.collateral,
    direction: "short" as string,
    isStopOrder: true,
  })) : [];
  const allPendingOrders = apiPendingOrders.length > 0 ? apiPendingOrders : chainFallbackOrders;
  const hasPendingOrders = allPendingOrders.length > 0;
  const hasChainTrades = closedChainTrades.length > 0;

  if (!hasPositions && !hasChainTrades && !hasPendingOrders) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Activity className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No positions yet</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Positions appear when the agent opens trades on-chain</p>
      </div>
    );
  }

  const openPositions = (positions || []).filter((p) => p.status === "open" || p.status === "pending_open");
  // Exclude cancelled_unfilled — these are orders that were never filled (not completed trades)
  const closedPositions = (positions || []).filter((p) => p.status === "closed" && p.closeTxDigest !== "cancelled_unfilled");
  const onChainOnly = untrackedPositions || [];
  const totalOpenCount = openPositions.length + onChainOnly.length;

  return (
    <div className="space-y-4" data-testid="positions-panel">
      {totalOpenCount > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Lock className="h-3 w-3 text-primary" />
              Open Positions ({totalOpenCount})
            </p>
            {openPositions.length > 0 && <CloseAllButton agentId={agentId} openCount={openPositions.length} />}
          </div>
          {openPositions.map((pos) => {
            const pnl = livePrice > 0
              ? (pos.side === "long"
                ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
                : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice)
              : 0;
            const collateral = pos.collateral || (pos.sizeSui / leverage);
            const cappedPnl = Math.max(-collateral, pnl);
            const pnlPercent = pos.entryPrice > 0
              ? (pos.side === "long"
                ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100
                : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100)
              : 0;
            const liqDenom = pos.liquidationPrice && pos.liquidationPrice > 0
              ? (pos.side === "long"
                ? pos.entryPrice - pos.liquidationPrice
                : pos.liquidationPrice - pos.entryPrice)
              : 0;
            const collateralLossPct = liqDenom > 0
              ? Math.min(100, Math.max(0, (
                  pos.side === "long"
                    ? (pos.entryPrice - livePrice) / liqDenom
                    : (livePrice - pos.entryPrice) / liqDenom
                ) * 100))
              : (cappedPnl < 0 ? Math.min(100, (-cappedPnl / collateral) * 100) : 0);

            const isPendingOpen = pos.status === "pending_open";
            const closeState = (pos as any).closeState;
            const isClosing = closeState === "close_tx_submitted";
            const isAwaitingFill = closeState === "close_order_working";
            const isTransitioning = isPendingOpen || isClosing || isAwaitingFill;
            return (
              <div key={pos.id} className={`rounded-lg border ${isTransitioning ? "border-amber-500/40 bg-amber-500/5" : "border-border/40 bg-card/50"} p-3 space-y-2`} data-testid={`position-open-${pos.id}`}>
                {isPendingOpen && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[10px] font-medium animate-pulse" data-testid={`pending-open-${pos.id}`}>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Opening... verifying on-chain
                  </div>
                )}
                {isClosing && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[10px] font-medium animate-pulse" data-testid={`closing-${pos.id}`}>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Closing... transaction submitted
                  </div>
                )}
                {isAwaitingFill && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[10px] font-medium animate-pulse" data-testid={`awaiting-fill-${pos.id}`}>
                    <Clock className="h-3 w-3" />
                    Awaiting fill... order working
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[10px]">
                        {pos.side.toUpperCase()}
                      </Badge>
                      <span
                        className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-background ${
                          collateralLossPct > 50 ? "bg-red-500" : collateralLossPct > 20 ? "bg-amber-500" : "bg-emerald-500"
                        }`}
                        data-testid={`position-health-${pos.id}`}
                        title={`${collateralLossPct.toFixed(1)}% collateral at risk`}
                      />
                    </div>
                    <span className="text-xs font-mono font-bold">{pos.sizeSui.toFixed(2)} SUI</span>
                    <Badge variant="outline" className="text-[8px] font-mono" data-testid={`badge-leverage-${pos.id}`}>
                      {leverage}x
                    </Badge>
                  </div>
                  {!isPendingOpen && (
                    <ClosePositionButton agentId={agentId} positionId={pos.id} side={pos.side} sizeSui={pos.sizeSui} />
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <span className={`text-sm font-mono font-bold ${cappedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-${pos.id}`}>
                    {cappedPnl >= 0 ? "+" : ""}{cappedPnl.toFixed(4)} SUI
                    <span className="text-[10px] ml-1 opacity-70">({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%)</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry</span>
                    <span className="font-mono">${pos.entryPrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mark</span>
                    <span className="font-mono">${livePrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Collateral</span>
                    <span className="font-mono text-primary">{collateral.toFixed(4)} SUI <Lock className="h-2 w-2 inline" /></span>
                  </div>
                  {pos.liquidationPrice && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Liquidation</span>
                      <span className="font-mono text-red-400">${pos.liquidationPrice.toFixed(4)}</span>
                    </div>
                  )}
                  {stopLossBps && pos.entryPrice > 0 && livePrice > 0 && (() => {
                    const MAX_COLLATERAL_LOSS_PCT = 4;
                    const effectiveSlBps = Math.floor((MAX_COLLATERAL_LOSS_PCT / (100 * leverage)) * 10000);
                    const actualSlBps = Math.min(stopLossBps, effectiveSlBps);
                    const isCapped = stopLossBps > effectiveSlBps;
                    const slPrice = pos.side === "long"
                      ? pos.entryPrice * (1 - actualSlBps / 10000)
                      : pos.entryPrice * (1 + actualSlBps / 10000);
                    const slDistPct = pos.side === "long"
                      ? ((livePrice - slPrice) / livePrice) * 100
                      : ((slPrice - livePrice) / livePrice) * 100;
                    const tpPrice = takeProfitBps
                      ? (pos.side === "long"
                        ? pos.entryPrice * (1 + takeProfitBps / 10000)
                        : pos.entryPrice * (1 - takeProfitBps / 10000))
                      : null;
                    const tpDistPct = tpPrice
                      ? (pos.side === "long"
                        ? ((tpPrice - livePrice) / livePrice) * 100
                        : ((livePrice - tpPrice) / livePrice) * 100)
                      : null;
                    return (
                      <>
                        <div className="flex justify-between" data-testid={`position-sl-distance-${pos.id}`}>
                          <span className={`${isCapped ? "text-amber-400" : "text-muted-foreground"}`}>
                            {isCapped ? "Eff. SL" : "SL"}
                          </span>
                          <span className={`font-mono ${slDistPct > 0 ? "text-amber-400" : "text-red-500"}`}>
                            {slDistPct.toFixed(2)}% away
                          </span>
                        </div>
                        {isCapped && (
                          <div className="col-span-2 flex items-center gap-1 text-[8px] text-amber-400/80 mt-0.5" data-testid={`position-sl-capped-${pos.id}`}>
                            <AlertTriangle className="h-2.5 w-2.5 flex-shrink-0" />
                            <span>Config {stopLossBps}bp capped → {effectiveSlBps}bp effective at {leverage}x (4% max loss)</span>
                          </div>
                        )}
                        {tpDistPct !== null && (
                          <div className="flex justify-between" data-testid={`position-tp-distance-${pos.id}`}>
                            <span className="text-muted-foreground">TP</span>
                            <span className={`font-mono ${tpDistPct > 0 ? "text-emerald-400" : "text-emerald-500"}`}>
                              {tpDistPct.toFixed(2)}% away
                            </span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>

                {collateralLossPct > 0 && (
                  <div className="space-y-0.5">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          collateralLossPct > 50 ? "bg-red-500" : collateralLossPct > 25 ? "bg-amber-500" : "bg-primary"
                        }`}
                        style={{ width: `${Math.min(100, collateralLossPct)}%` }}
                      />
                    </div>
                    <p className="text-[8px] text-muted-foreground text-right">{collateralLossPct.toFixed(1)}% collateral at risk</p>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <TxLink txDigest={pos.txDigest} label="Open TX" />
                  {pos.onChainPositionId && (
                    <a
                      href={`https://suivision.xyz/object/${pos.onChainPositionId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[8px] text-cyan-400 hover:underline font-mono"
                      title={`Position Object: ${pos.onChainPositionId}`}
                      data-testid={`link-position-object-${pos.id}`}
                    >
                      <ExternalLink className="h-2 w-2 shrink-0" />
                      {pos.onChainPositionId.slice(0, 8)}...{pos.onChainPositionId.slice(-6)}
                    </a>
                  )}
                  {!pos.onChainPositionId && !isPendingOpen && (
                    <span className="text-[8px] text-amber-400/60 font-mono" data-testid={`text-no-position-id-${pos.id}`}>
                      No on-chain ID
                    </span>
                  )}
                </div>
                {pos.openedAt && (() => {
                  const ageMs = Date.now() - new Date(pos.openedAt).getTime();
                  const ageMins = Math.floor(ageMs / 60000);
                  const ageText = ageMins < 60
                    ? `Opened ${ageMins} min ago`
                    : `Opened ${Math.floor(ageMins / 60)} hours ago`;
                  return (
                    <p className="text-[8px] text-muted-foreground/60 flex items-center gap-1" data-testid={`position-age-${pos.id}`}>
                      <Clock className="h-2.5 w-2.5" />
                      {ageText}
                    </p>
                  );
                })()}
              </div>
            );
          })}
          {onChainOnly.map((ocp) => {
            const pnl = livePrice > 0 && ocp.entryPrice > 0
              ? (ocp.side === "long"
                ? (livePrice - ocp.entryPrice) * ocp.size / livePrice
                : (ocp.entryPrice - livePrice) * ocp.size / livePrice)
              : 0;
            const cappedPnl = Math.max(-ocp.collateral, pnl);
            const pnlPercent = ocp.entryPrice > 0
              ? (ocp.side === "long"
                ? ((livePrice - ocp.entryPrice) / ocp.entryPrice) * 100
                : ((ocp.entryPrice - livePrice) / ocp.entryPrice) * 100)
              : 0;

            return (
              <div key={`untracked-${ocp.positionId}`} className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 space-y-2" data-testid={`position-untracked-${ocp.positionId}`}>
                <div className="flex items-center gap-1.5 text-blue-400 text-[10px] font-medium">
                  <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                  Recovering position — auto-syncing to dashboard
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={ocp.side === "long" ? "default" : "destructive"} className="text-[10px]">
                      {ocp.side.toUpperCase()}
                    </Badge>
                    <span className="text-xs font-mono font-bold">{ocp.size.toFixed(2)} SUI</span>
                    <Badge variant="outline" className="text-[8px] font-mono">
                      {leverage}x
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className={`text-sm font-mono font-bold ${cappedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {cappedPnl >= 0 ? "+" : ""}{cappedPnl.toFixed(4)} SUI
                    <span className="text-[10px] ml-1 opacity-70">({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%)</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entry</span>
                    <span className="font-mono">${ocp.entryPrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mark</span>
                    <span className="font-mono">${livePrice.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Collateral</span>
                    <span className="font-mono">{ocp.collateral.toFixed(4)} SUI</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Position ID</span>
                    <span className="font-mono text-cyan-400">{ocp.positionId}</span>
                  </div>
                </div>
                <div className="text-[8px] text-blue-400/60 italic">
                  Will be fully managed within ~60 seconds
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasPendingOrders && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Clock className="h-3 w-3 text-amber-400" />
              Pending Orders ({allPendingOrders.length})
            </p>
          </div>
          {allPendingOrders.map((order) => (
            <div key={`pending-${order.orderId}`} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2" data-testid={`pending-order-${order.orderId}`}>
              <div className="flex items-center gap-1.5 text-amber-400 text-[10px] font-medium">
                <Timer className="h-3 w-3" />
                {order.isStopOrder ? "Stop Order" : "Pending Order"} #{order.orderId}
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={order.direction === "long" ? "default" : "destructive"} className="text-[10px]">
                    {order.direction.toUpperCase()}
                  </Badge>
                  <span className="text-xs font-mono font-bold">{order.collateral.toFixed(2)} SUI</span>
                  <Badge variant="outline" className="text-[8px] font-mono border-amber-500/30 text-amber-400">
                    {order.isStopOrder ? "STOP" : "LIMIT"}
                  </Badge>
                </div>
                {!order.orderId.startsWith("chain-") && (
                  <CancelOrderButton agentId={agentId} orderId={order.orderId} collateral={order.collateral} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Collateral</span>
                  <span className="font-mono text-amber-400">{order.collateral.toFixed(4)} SUI <Lock className="h-2 w-2 inline" /></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className="font-mono text-amber-400">Awaiting fill</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(() => {
        const closeReasonLabel: Record<string, string> = {
          "stop-loss": "Stop Loss", "take-profit": "Take Profit",
          "emergency-liquidation-prevent": "Emergency Close", "max-collateral-loss": "Max Loss Cap",
          "manual": "Manual Close", "agent-shutdown": "Agent Shutdown", "recovery": "Recovery",
          "liquidated": "Liquidated", "settled_onchain": "Settled On-Chain",
          "signal-tp": "Signal TP", "signal-sl": "Signal SL",
          "learning-tp": "Learn TP", "learning-sl": "Learn SL",
          "trailing-stop": "Trailing Stop",
        };

        const matchedDbDigests = new Set<string>();
        const mergedItems: Array<{
          key: string;
          chainTrade: ChainTrade | null;
          dbPos: Position | null;
        }> = [];

        const allChainTrades = chainTrades || [];
        const cancelledTrades = allChainTrades.filter(t => t.outcome === "cancelled");
        for (const trade of cancelledTrades) {
          const dbPos = closedPositions.find(p => p.txDigest === trade.openDigest);
          if (dbPos && dbPos.closeTxDigest === "cancelled_unfilled") {
            matchedDbDigests.add(dbPos.id);
          }
        }

        for (const trade of closedChainTrades) {
          const dbPos = closedPositions.find(p => p.txDigest === trade.openDigest || p.closeTxDigest === trade.closeDigest);
          if (dbPos) matchedDbDigests.add(dbPos.id);
          mergedItems.push({ key: `chain-${trade.openDigest}`, chainTrade: trade, dbPos: dbPos || null });
        }

        for (const pos of closedPositions) {
          if (!matchedDbDigests.has(pos.id)) {
            if (pos.txDigest?.startsWith("reopened_") && !pos.onChainPositionId) continue;
            mergedItems.push({ key: `db-${pos.id}`, chainTrade: null, dbPos: pos });
          }
        }

        if (mergedItems.length === 0) return null;

        const totalPnl = mergedItems.reduce((s, item) => {
          if (item.chainTrade) return s + item.chainTrade.pnlSui;
          return s + (item.dbPos?.unrealizedPnl || 0);
        }, 0);
        const wins = mergedItems.filter(item => {
          if (item.chainTrade) return item.chainTrade.pnlSui > 0;
          return (item.dbPos?.unrealizedPnl || 0) > 0;
        }).length;

        const verifiedCount = mergedItems.filter(item =>
          (item.dbPos as any)?.pnlSource === "onchain_verified" || (item.dbPos as any)?.pnlSource === "keeper_verified"
        ).length;

        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Closed ({mergedItems.length})</p>
              <div className="flex items-center gap-2 text-[9px]">
                <span className={`font-mono font-bold ${totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-closed-total-pnl">
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)} SUI
                </span>
                <Badge variant="outline" className="text-[8px]" data-testid="text-closed-win-loss">{wins}W/{mergedItems.length - wins}L</Badge>
                {verifiedCount > 0 && (
                  <Badge variant="outline" className="text-[8px] text-emerald-400 border-emerald-400/50" data-testid="badge-pnl-verified-count">
                    <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />{verifiedCount} verified
                  </Badge>
                )}
              </div>
            </div>
            {mergedItems.map((item, idx) => {
              if (item.chainTrade) {
                const trade = item.chainTrade;
                const dbPos = item.dbPos;
                const isLiquidated = trade.outcome === "liquidated";

                return (
                  <div key={item.key} className="rounded bg-card/30 px-3 py-2 space-y-1.5" data-testid={`position-closed-chain-${idx}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        {dbPos && (
                          <Badge variant={dbPos.side === "long" ? "default" : "destructive"} className="text-[9px] opacity-70">
                            {dbPos.side.toUpperCase()}
                          </Badge>
                        )}
                        {isLiquidated && <Badge variant="destructive" className="text-[7px]" data-testid={`badge-liquidated-chain-${idx}`}>LIQ</Badge>}
                        <span className="text-[10px] font-mono">{(dbPos ? dbPos.sizeSui : trade.collateral * leverage).toFixed(2)} SUI</span>
                        {dbPos?.closeReason && (
                          <Badge variant="outline" className="text-[7px] opacity-60">
                            {closeReasonLabel[dbPos.closeReason] || dbPos.closeReason}
                          </Badge>
                        )}
                        {!dbPos?.closeReason && isLiquidated && (
                          <Badge variant="outline" className="text-[7px] opacity-60">Liquidated</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {((dbPos as any)?.pnlSource === "onchain_verified" || (dbPos as any)?.pnlSource === "keeper_verified") && (
                          <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400 flex-shrink-0" title={`PnL ${(dbPos as any)?.pnlSource === "keeper_verified" ? "keeper-verified" : "on-chain verified"}${(dbPos as any)?.returnedSui ? `: ${(dbPos as any)?.returnedSui.toFixed(4)} SUI returned` : ""}`} data-testid={`icon-pnl-verified-chain-${idx}`} />
                        )}
                        <span className={`text-[11px] font-mono font-bold ${trade.pnlSui >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid={`text-pnl-chain-${idx}`}>
                          {trade.pnlSui >= 0 ? "+" : ""}{trade.pnlSui.toFixed(4)}
                        </span>
                        {trade.closeDigest && (
                          <a href={`https://suivision.xyz/txblock/${trade.closeDigest}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80" title="Verify on-chain" data-testid={`link-pnl-verify-chain-${idx}`}>
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[8px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Collateral</span>
                        <span className="font-mono">{trade.collateral.toFixed(4)} SUI</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Returned</span>
                        <span className={`font-mono ${trade.returned > 0 ? "text-muted-foreground" : "text-red-400"}`}>{trade.returned.toFixed(4)} SUI</span>
                      </div>
                      {dbPos && (
                        <>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Entry</span>
                            <span className="font-mono">${dbPos.entryPrice.toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Exit</span>
                            <span className="font-mono">${dbPos.markPrice.toFixed(4)}</span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="text-[8px] text-muted-foreground border-t border-border/20 pt-1">
                      {isLiquidated ? (
                        <span className="text-red-400">Collateral lost: -{trade.collateral.toFixed(4)} SUI (100%)</span>
                      ) : trade.pnlSui < 0 ? (
                        <span className="text-red-400">Loss: {trade.collateral.toFixed(4)} → {trade.returned.toFixed(4)} SUI | -{Math.abs(trade.pnlSui).toFixed(4)} SUI</span>
                      ) : (
                        <span className="text-emerald-500">Gain: {trade.collateral.toFixed(4)} → {trade.returned.toFixed(4)} SUI | +{trade.pnlSui.toFixed(4)} SUI</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <TxLink txDigest={trade.openDigest} label="Open" />
                      <TxLink txDigest={trade.closeDigest} label="Close" />
                      {trade.closeTimestamp && <span className="text-[8px] text-muted-foreground/50">{new Date(trade.closeTimestamp).toLocaleString()}</span>}
                    </div>
                  </div>
                );
              }

              const pos = item.dbPos!;
              const collateral = pos.collateral || (pos.sizeSui / leverage);
              const pnl = pos.unrealizedPnl || 0;
              const isLiquidated = pos.closeReason === "liquidated" || pos.closeTxDigest === "liquidated_onchain";
              const pnlSource = (pos as any).pnlSource as string | undefined;
              const returnedSuiVerified = (pos as any).returnedSui as number | undefined;
              const isVerified = pnlSource === "onchain_verified" || pnlSource === "keeper_verified";
              const returned = isLiquidated ? 0 : (returnedSuiVerified ?? Math.max(0, collateral + pnl));
              const SYNTHETIC_CLOSE_DIGESTS = ["settled_onchain", "position_gone_onchain", "prior_fill", "closed_externally"];
              const isSettledSynthetic = !!pos.closeTxDigest && SYNTHETIC_CLOSE_DIGESTS.includes(pos.closeTxDigest) && !isVerified;
              const priceMovePct = pos.entryPrice > 0
                ? (pos.side === "long"
                  ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100
                  : ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100)
                : 0;
              const priceDirectionConflict = isSettledSynthetic && ((pnl < 0 && priceMovePct > 0.01) || (pnl > 0 && priceMovePct < -0.01));

              return (
                <div key={item.key} className="rounded bg-card/30 px-3 py-2 space-y-1.5" data-testid={`position-closed-${pos.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-[9px] opacity-70">{pos.side.toUpperCase()}</Badge>
                      {isLiquidated && <Badge variant="destructive" className="text-[7px]" data-testid={`badge-liquidated-${pos.id}`}>LIQ</Badge>}
                      <span className="text-[10px] font-mono">{pos.sizeSui.toFixed(2)} SUI</span>
                      {pos.closeReason && (
                        <Badge variant="outline" className="text-[7px] opacity-60">{closeReasonLabel[pos.closeReason] || pos.closeReason}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {((pos as any).pnlSource === "onchain_verified" || (pos as any).pnlSource === "keeper_verified") && (
                        <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400 flex-shrink-0" title={`PnL ${(pos as any).pnlSource === "keeper_verified" ? "keeper-verified" : "on-chain verified"}${(pos as any).returnedSui ? `: ${(pos as any).returnedSui.toFixed(4)} SUI returned` : ""}`} data-testid={`icon-pnl-verified-${pos.id}`} />
                      )}
                      <span className={`text-[11px] font-mono font-bold ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}</span>
                      {pos.closeTxDigest && !["settled_onchain", "liquidated_onchain", "prior_fill", "closed_externally", "position_gone_onchain", "verified_closed", "retry_close"].includes(pos.closeTxDigest) && (
                        <a href={`https://suivision.xyz/txblock/${pos.closeTxDigest}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80" title="Verify PnL on-chain" data-testid={`link-pnl-verify-${pos.id}`}>
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[8px]">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Collateral</span>
                      <span className="font-mono">{collateral.toFixed(4)} SUI</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Price Move</span>
                      <span className={`font-mono ${priceMovePct >= 0 ? "text-emerald-500" : "text-red-400"}`}>{priceMovePct >= 0 ? "+" : ""}{priceMovePct.toFixed(3)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Entry</span>
                      <span className="font-mono">${pos.entryPrice.toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Exit</span>
                      <span className="font-mono">${pos.markPrice.toFixed(4)}</span>
                    </div>
                  </div>
                  <div className="text-[8px] text-muted-foreground border-t border-border/20 pt-1">
                    {isLiquidated ? (
                      <span className="text-red-400">Collateral lost: -{collateral.toFixed(4)} SUI (100%)</span>
                    ) : isSettledSynthetic || priceDirectionConflict ? (
                      <span className={pnl >= 0 ? "text-emerald-500" : "text-red-400"}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} SUI | Returned: {returned.toFixed(4)} SUI
                        <span className="text-muted-foreground/60 ml-1" data-testid={`text-reconciled-${pos.id}`}>(keeper TX not yet found — verifying...)</span>
                      </span>
                    ) : pnl < 0 ? (
                      <span className="text-red-400">Loss: {priceMovePct.toFixed(3)}% × {leverage}x lev = {(Math.abs(priceMovePct) * leverage).toFixed(1)}% of collateral → -{Math.min(collateral, Math.abs(pnl)).toFixed(4)} SUI | Returned: {returned.toFixed(4)} SUI</span>
                    ) : (
                      <span className="text-emerald-500">Gain: +{priceMovePct.toFixed(3)}% × {leverage}x lev → +{pnl.toFixed(4)} SUI | Returned: {returned.toFixed(4)} SUI</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <TxLink txDigest={pos.txDigest} label="Open" />
                    <TxLink txDigest={pos.closeTxDigest} label="Close" />
                    {pos.closedAt && <span className="text-[8px] text-muted-foreground/50">{new Date(pos.closedAt).toLocaleString()}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

function FundStatus({ agent, positions, activity, computed, settlingCount, settlingPositionsList, portfolioIsVerified }: {
  agent: AgentWithSignalAgent;
  positions: Position[];
  activity: any;
  computed: {
    onChainWallet: number;
    lockedCollateral: number;
    unrealizedPnl: number;
    pendingOrderCollateral: number;
    portfolioValue: number;
    realizedPnl: number;
    gasCosts: number;
    rewardsPaid: number;
    netDeposited: number;
    openPositionCount: number;
  };
  settlingCount: number;
  settlingPositionsList: Array<{ id: string; side: string; collateral: number; closeState: string }>;
  portfolioIsVerified?: boolean;
}) {
  const { toast } = useToast();
  const [showTradeHistory, setShowTradeHistory] = useState(false);
  const [showCapitalReasoning, setShowCapitalReasoning] = useState(false);

  const { data: capitalPlan } = useQuery<{
    agentId: string;
    recommendedMaxPositions: number;
    sizeMultiplier: number;
    freeSuiReserveTarget: number;
    hedgeEligible: boolean;
    hedgeReason: string;
    profitReinvestmentRate: number;
    adaptiveScoreBonus: number;
    reasoning: string[];
  }>({
    queryKey: ["/api/agents", agent.id, "capital-plan"],
    refetchInterval: 30000,
  });

  const { data: fastPositions } = useQuery<{
    positions: Position[];
    untrackedOnChainPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }>;
    liveSuiPrice: number;
  }>({
    queryKey: ["/api/agents", agent.id, "positions"],
    refetchInterval: 3000,
    staleTime: 2500,
  });

  const openPositions = (fastPositions?.positions ?? positions).filter(p => p.status === "open" || p.status === "pending_open");
  const untrackedPositions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number }> = fastPositions?.untrackedOnChainPositions ?? (activity as any)?.untrackedOnChainPositions ?? [];
  const leverage = agent.leverage;
  const stopLossBps = agent.stopLossBps ?? 50;
  const takeProfitBps = agent.takeProfitBps ?? 0;

  const { onChainWallet, lockedCollateral: totalLocked, unrealizedPnl: liveUnrealizedPnl,
    pendingOrderCollateral, portfolioValue: totalPortfolioValue, realizedPnl,
    gasCosts, rewardsPaid, netDeposited } = computed;
  const pendingOrders = activity?.pendingOrders ?? [];
  const totalPositionCount = openPositions.length + untrackedPositions.length;
  const fees = agent.protocolFeePaid || 0;
  const chainTrades = activity?.chainDerived?.chainTrades || [];
  const completedTrades = chainTrades.filter((t: any) => t.outcome !== "open" && t.outcome !== "cancelled" && t.outcome !== "pending_order");
  const walletAddr = agent.walletAddress || "";
  const walletShort = walletAddr ? walletAddr.slice(0, 6) + "..." + walletAddr.slice(-4) : "";

  return (
    <div className="space-y-3" data-testid="fund-status">
      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-3">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Eye className="h-3 w-3" />
          On-Chain Portfolio
        </p>

        {settlingCount > 0 && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 flex items-center gap-2 animate-pulse" data-testid="settling-banner">
            <Loader2 className="h-3 w-3 text-amber-400 animate-spin shrink-0" />
            <span className="text-[9px] text-amber-400">
              Settling {settlingCount} position{settlingCount > 1 ? "s" : ""}... values may update momentarily
            </span>
          </div>
        )}

        <div className={`rounded-lg p-2.5 flex items-center justify-between border transition-colors duration-500 ${
          portfolioIsVerified
            ? "bg-emerald-500/5 border-emerald-500/20"
            : "bg-blue-500/5 border-blue-500/20"
        }`}>
          <div>
            <p className="text-[8px] text-muted-foreground">Total Portfolio Value</p>
            <p className={`text-[7px] ${portfolioIsVerified ? "text-emerald-500/60" : "text-blue-400/60"}`}>
              {portfolioIsVerified ? "verified on-chain" : settlingCount > 0 ? "adjusting..." : "estimated"}
            </p>
          </div>
          <p className={`text-lg font-mono font-bold transition-colors duration-500 ${portfolioIsVerified ? "text-emerald-500" : "text-blue-400"}`} data-testid="text-total-portfolio">
            {fmtSui(totalPortfolioValue)} <span className={`text-xs ${portfolioIsVerified ? "text-emerald-500/50" : "text-blue-400/50"}`}>SUI</span>
          </p>
        </div>

        <div className="space-y-1">
          <div className="rounded bg-blue-500/5 border border-blue-500/20 px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-blue-400 flex items-center gap-1">
                <Briefcase className="h-2.5 w-2.5" />Invested
                {settlingCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[7px] text-amber-400">
                    <Loader2 className="h-2 w-2 animate-spin" />settling
                  </span>
                )}
              </span>
              <span className="text-[11px] font-mono font-bold text-blue-400" data-testid="text-invested">
                {(totalLocked + pendingOrderCollateral + liveUnrealizedPnl).toFixed(4)} SUI
              </span>
            </div>
            {(totalLocked > 0.001 || pendingOrderCollateral > 0.001) && (
              <div className="mt-1 space-y-0.5 pl-4 border-l border-blue-500/20">
                {totalLocked > 0.001 && (
                  <div className="flex items-center justify-between text-[8px]">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Lock className="h-2 w-2" />Locked in Positions
                    </span>
                    <span className="font-mono text-blue-300" data-testid="text-locked">
                      {totalLocked.toFixed(4)} SUI
                      <span className={`ml-1 ${totalPositionCount === 0 && totalLocked > 0.001 ? "text-amber-400/70" : "text-muted-foreground/60"}`}>
                        {totalPositionCount === 0 && totalLocked > 0.001 ? "(settling)" : `(${totalPositionCount} pos)`}
                      </span>
                    </span>
                  </div>
                )}
                {pendingOrderCollateral > 0.001 && (
                  <div className="flex items-center justify-between text-[8px]">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-2 w-2" />Pending Orders
                    </span>
                    <span className="font-mono text-amber-400" data-testid="text-pending-orders">
                      {pendingOrderCollateral.toFixed(4)} SUI
                      <span className="text-amber-400/60 ml-1">({pendingOrders.length})</span>
                    </span>
                  </div>
                )}
                {liveUnrealizedPnl !== 0 && (
                  <div className="flex items-center justify-between text-[8px]">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <TrendingUp className="h-2 w-2" />Unrealized PnL
                    </span>
                    <span className={`font-mono ${liveUnrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-unrealized-pnl">
                      {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(4)} SUI
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded bg-card/60 border border-border/20 px-2.5 py-1.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-muted-foreground flex items-center gap-1">
                <Wallet className="h-2.5 w-2.5" />Funding Wallet
                <span className="text-[7px] text-muted-foreground/50">(gas + trading)</span>
              </span>
              <div className="text-right">
                <span className="text-[11px] font-mono font-bold" data-testid="text-onchain-wallet">{onChainWallet.toFixed(4)} SUI</span>
                {walletAddr && (
                  <a
                    href={`https://suiscan.xyz/mainnet/account/${walletAddr}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[7px] text-primary/60 hover:text-primary underline decoration-dotted font-mono"
                    data-testid="link-wallet-address"
                  >
                    {walletShort}
                  </a>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between pl-3 border-l border-emerald-500/20">
              <span className="text-[9px] text-emerald-400/80 flex items-center gap-1">
                <PiggyBank className="h-2.5 w-2.5" />Savings Wallet
                <span className="text-[7px] text-emerald-400/40">({activity?.savingsSplitPct ?? 10}% of profit)</span>
              </span>
              <div className="text-right">
                <span className="text-[11px] font-mono font-bold text-emerald-400" data-testid="text-savings-balance">
                  {(activity?.savingsBalance ?? 0).toFixed(4)} SUI
                </span>
                {activity?.savingsWalletAddress && (
                  <a
                    href={`https://suiscan.xyz/mainnet/account/${activity.savingsWalletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[7px] text-emerald-400/40 hover:text-emerald-400 underline decoration-dotted font-mono"
                  >
                    {activity.savingsWalletAddress.slice(0, 6)}...{activity.savingsWalletAddress.slice(-4)}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {capitalPlan && (
          <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2" data-testid="capital-plan-card">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Brain className="h-3 w-3 text-primary" />
              Capital Strategy
            </p>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[9px]" data-testid="capital-plan-max-positions">
                <span className="text-muted-foreground">Max Positions</span>
                <span className={`font-mono font-bold ${computed.openPositionCount >= capitalPlan.recommendedMaxPositions ? "text-amber-400" : "text-emerald-500"}`}>
                  {computed.openPositionCount}/{capitalPlan.recommendedMaxPositions}
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px]" data-testid="capital-plan-size-mult">
                <span className="text-muted-foreground">Size Multiplier</span>
                <span className="font-mono font-bold">{capitalPlan.sizeMultiplier.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-[9px]" data-testid="capital-plan-reserve">
                <span className="text-muted-foreground">Reserve Target</span>
                <span className={`font-mono font-bold ${computed.onChainWallet >= capitalPlan.freeSuiReserveTarget ? "text-emerald-500" : "text-red-500"}`}>
                  {capitalPlan.freeSuiReserveTarget.toFixed(2)} SUI
                  <span className="text-[7px] text-muted-foreground ml-1">(Free: {computed.onChainWallet.toFixed(2)})</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px]" data-testid="capital-plan-hedge">
                <span className="text-muted-foreground">Hedge Eligible</span>
                <span className={`font-mono font-bold ${capitalPlan.hedgeEligible ? "text-emerald-500" : "text-muted-foreground"}`}>
                  {capitalPlan.hedgeEligible ? "Yes" : "No"}
                  <span className="text-[7px] text-muted-foreground ml-1">({capitalPlan.hedgeReason})</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px]" data-testid="capital-plan-reinvest">
                <span className="text-muted-foreground">Reinvest Rate</span>
                <span className="font-mono font-bold">{(capitalPlan.profitReinvestmentRate * 100).toFixed(0)}%</span>
              </div>
              {capitalPlan.gasSafety && (
                <div className="border-t border-border/20 pt-1 mt-1" data-testid="gas-safety-section">
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Fuel className="h-2.5 w-2.5" />
                      Gas Safety
                    </span>
                    <span className={`font-mono font-bold flex items-center gap-1 ${
                      capitalPlan.gasSafety.status === "breached" ? "text-red-500" :
                      capitalPlan.gasSafety.status === "critical" ? "text-orange-500" :
                      capitalPlan.gasSafety.status === "warning" ? "text-amber-400" :
                      "text-emerald-500"
                    }`} data-testid="text-gas-safety-status">
                      {capitalPlan.gasSafety.status === "breached" && <AlertTriangle className="h-2.5 w-2.5" />}
                      {capitalPlan.gasSafety.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-muted-foreground">Session Gas</span>
                    <span className="font-mono text-muted-foreground" data-testid="text-session-gas">
                      {capitalPlan.gasSafety.sessionGasUsed.toFixed(4)} / {capitalPlan.gasSafety.effectiveCap.toFixed(2)} SUI
                    </span>
                  </div>
                  {capitalPlan.gasSafety.utilizationPct > 0 && (
                    <div className="mt-1 h-1 rounded-full bg-muted/30 overflow-hidden" data-testid="gas-utilization-bar">
                      <div
                        className={`h-full rounded-full transition-all ${
                          capitalPlan.gasSafety.utilizationPct >= 75 ? "bg-red-500" :
                          capitalPlan.gasSafety.utilizationPct >= 50 ? "bg-amber-400" :
                          "bg-emerald-500"
                        }`}
                        style={{ width: `${Math.min(capitalPlan.gasSafety.utilizationPct, 100)}%` }}
                      />
                    </div>
                  )}
                  {capitalPlan.gasSafety.reason && (
                    <p className={`text-[7px] mt-1 ${capitalPlan.gasSafety.breached ? "text-red-400/80" : capitalPlan.gasSafety.utilizationPct >= 60 ? "text-amber-400/80" : "text-muted-foreground/60"}`} data-testid="text-gas-breach-reason">
                      {capitalPlan.gasSafety.reason}
                    </p>
                  )}
                </div>
              )}
            </div>
            {capitalPlan.reasoning && capitalPlan.reasoning.length > 0 && (
              <div>
                <button
                  className="w-full flex items-center justify-between text-[8px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                  onClick={() => setShowCapitalReasoning(!showCapitalReasoning)}
                  data-testid="button-toggle-capital-reasoning"
                >
                  <span>Reasoning ({capitalPlan.reasoning.length})</span>
                  <ChevronDown className={`h-2.5 w-2.5 transition-transform ${showCapitalReasoning ? "rotate-180" : ""}`} />
                </button>
                {showCapitalReasoning && (
                  <ul className="mt-1 space-y-0.5" data-testid="capital-plan-reasoning">
                    {capitalPlan.reasoning.map((r, i) => (
                      <li key={i} className="text-[8px] text-muted-foreground/60 flex items-start gap-1">
                        <span className="text-primary/40 mt-0.5 shrink-0">&#8226;</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-1.5" data-testid="settlement-tracker-card">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Coins className="h-3 w-3 text-primary" />
            Keeper Settlement Flow
          </p>
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-muted-foreground flex items-center gap-1">
              <ArrowUpRight className="h-2.5 w-2.5 text-orange-400" />Collateral Deployed
            </span>
            <span className="font-mono text-orange-400" data-testid="text-collateral-deployed">
              -{(activity?.collateralDeployed ?? 0).toFixed(4)} SUI
            </span>
          </div>
          {(computed.lockedCollateral ?? 0) > 0 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground flex items-center gap-1">
                <Lock className="h-2.5 w-2.5 text-blue-400" />In Typus (Open)
              </span>
              <span className="font-mono text-blue-400" data-testid="text-locked-in-typus">
                +{(computed.lockedCollateral ?? 0).toFixed(4)} SUI
              </span>
            </div>
          )}
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-muted-foreground flex items-center gap-1">
              <ArrowDownToLine className="h-2.5 w-2.5 text-emerald-400" />Settlement Received
            </span>
            <span className="font-mono text-emerald-400" data-testid="text-settlement-received">
              +{(activity?.settlementReceived ?? 0).toFixed(4)} SUI
            </span>
          </div>
          {(activity?.keeperOnChainSettlement ?? 0) > 0 && (activity?.keeperOnChainSettlement ?? 0) < (activity?.settlementReceived ?? 0) && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground/60 flex items-center gap-1">
                <CheckCircle2 className="h-2.5 w-2.5 text-teal-400" />On-Chain Verified
              </span>
              <span className="font-mono text-teal-400/80 text-[8px]" data-testid="text-keeper-verified-settlement">
                {(activity?.keeperOnChainSettlement ?? 0).toFixed(4)} SUI
              </span>
            </div>
          )}
          {(activity?.forceSettledLoss ?? 0) > 0.01 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground/70 flex items-center gap-1">
                <AlertTriangle className="h-2.5 w-2.5 text-red-400" />Force-settled Losses
              </span>
              <span className="font-mono text-red-400 text-[8px]" data-testid="text-force-settled-loss">
                -{(activity?.forceSettledLoss ?? 0).toFixed(4)} SUI
              </span>
            </div>
          )}
          <div className="flex items-center justify-between text-[9px] border-t border-border/20 pt-1">
            <span className="text-muted-foreground">Net Realized PnL</span>
            {(() => {
              const closedCollateral = (activity?.collateralDeployed ?? 0) - (computed.lockedCollateral ?? 0);
              const net = (activity?.settlementReceived ?? 0) - closedCollateral - (activity?.forceSettledLoss ?? 0);
              return (
                <span className={`font-mono font-bold ${net >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-net-keeper-flow">
                  {net >= 0 ? "+" : ""}{net.toFixed(4)} SUI
                </span>
              );
            })()}
          </div>
        </div>

        <div className="border-t border-border/20 pt-2 space-y-1">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">
            {activity?.chainDerived ? "On-Chain Accounting (verified)" : "Accounting"}
          </p>
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-muted-foreground">Net Deposited</span>
            <span className="font-mono" data-testid="text-deposited">{netDeposited.toFixed(2)} SUI</span>
          </div>
          {fees > 0 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground/60">Protocol Fee</span>
              <span className="font-mono text-muted-foreground/60">-{fees.toFixed(4)} SUI</span>
            </div>
          )}
          {realizedPnl !== 0 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">Realized PnL</span>
              <span className={`font-mono font-bold ${realizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-realized-pnl">
                {realizedPnl >= 0 ? "+" : ""}{realizedPnl.toFixed(4)} SUI
              </span>
            </div>
          )}
          {activity?.chainDerived && (
            <>
              {activity.chainDerived.wins > 0 && (
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-muted-foreground">Wins</span>
                  <span className="font-mono text-emerald-500" data-testid="text-chain-wins">{activity.chainDerived.wins} (+{activity.chainDerived.realizedGain.toFixed(4)} SUI)</span>
                </div>
              )}
              {activity.chainDerived.losses > 0 && (
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-muted-foreground">Losses</span>
                  <span className="font-mono text-red-500" data-testid="text-chain-losses">{activity.chainDerived.losses} ({activity.chainDerived.realizedLoss.toFixed(4)} SUI)</span>
                </div>
              )}
              {activity.chainDerived.liquidations > 0 && (
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-red-400">Liquidations</span>
                  <span className="font-mono font-bold text-red-500" data-testid="text-chain-liquidations">{activity.chainDerived.liquidations}</span>
                </div>
              )}
            </>
          )}
          {gasCosts > 0.001 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">Gas Costs</span>
              <span className="font-mono text-orange-400" data-testid="text-gas-costs">-{gasCosts.toFixed(4)} SUI</span>
            </div>
          )}
          {rewardsPaid > 0.001 && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">Rewards Paid</span>
              <span className="font-mono text-purple-400" data-testid="text-rewards-paid">-{rewardsPaid.toFixed(4)} SUI</span>
            </div>
          )}
          {netDeposited > 0.01 && (
            (() => {
              // Correct accounting: compare (free wallet + locked collateral) vs (deposited + realized - gas - rewards)
              // This avoids false residuals from price-based unrealized PnL vs on-chain locked amounts
              const verifiedPortfolio = onChainWallet + totalLocked;
              const accountedTotal = netDeposited + realizedPnl - gasCosts - rewardsPaid;
              const residual = verifiedPortfolio - accountedTotal;
              const hasResidual = Math.abs(residual) > 0.5 && !portfolioIsVerified;
              return (
                <div className="border-t border-border/10 pt-1 mt-1">
                  {hasResidual && (
                    <div className="flex items-center justify-between text-[9px]">
                      <span className="text-muted-foreground/50">Unreconciled</span>
                      <span className="font-mono text-muted-foreground/50" data-testid="text-discrepancy">
                        {residual >= 0 ? "+" : ""}{residual.toFixed(4)} SUI
                      </span>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
      </div>

      {completedTrades.length > 0 && (
        <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2">
          <button
            className="w-full flex items-center justify-between text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
            onClick={() => setShowTradeHistory(!showTradeHistory)}
            data-testid="button-toggle-trade-history"
          >
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              Trade History ({completedTrades.length} trades, on-chain verified)
            </span>
            <ChevronDown className={`h-3 w-3 transition-transform ${showTradeHistory ? "rotate-180" : ""}`} />
          </button>
          {showTradeHistory && (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {completedTrades.map((trade: any, idx: number) => {
                const pnl = trade.pnlSui;
                const outcomeColor = trade.outcome === "win" ? "text-emerald-500" : trade.outcome === "liquidated" ? "text-red-500" : "text-red-400";
                const outcomeLabel = trade.outcome === "win" ? "WIN" : trade.outcome === "liquidated" ? "LIQ" : "LOSS";
                return (
                  <div key={idx} className="rounded bg-card/60 border border-border/20 px-2.5 py-1.5 space-y-0.5" data-testid={`chain-trade-${idx}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[8px] font-bold ${outcomeColor}`}>{outcomeLabel}</span>
                        {trade.dbPositionMatch === "tracked"
                          ? <span className="text-[7px] text-emerald-500/70 font-mono">✓ db</span>
                          : <span className="text-[7px] text-amber-400/70 font-mono">chain-only</span>
                        }
                      </div>
                      <span className={`text-[10px] font-mono font-bold ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} SUI
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[8px] text-muted-foreground">
                      <span>Posted: {trade.collateral.toFixed(3)} SUI</span>
                      <span>Returned: {trade.returned.toFixed(3)} SUI</span>
                    </div>
                    <div className="flex items-center gap-2 text-[7px]">
                      <span className="text-muted-foreground/60">Open:</span>
                      <TxLink txDigest={trade.openDigest} />
                      {trade.closeDigest && (
                        <>
                          <span className="text-muted-foreground/60">Close:</span>
                          <TxLink txDigest={trade.closeDigest} />
                        </>
                      )}
                    </div>
                    {trade.openTimestamp && (
                      <div className="text-[7px] text-muted-foreground/40">
                        {new Date(trade.openTimestamp).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {totalPositionCount > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Open Positions</p>
          {openPositions.map((pos) => {
            const collateral = pos.collateral || (pos.sizeSui / leverage);
            const livePrice = activity?.liveSuiPrice || 0;
            const pnl = livePrice > 0
              ? (pos.side === "long"
                ? (livePrice - pos.entryPrice) * pos.sizeSui / livePrice
                : (pos.entryPrice - livePrice) * pos.sizeSui / livePrice)
              : 0;
            const cappedPnl = Math.max(-collateral, pnl);
            const pnlPct = collateral > 0 ? (cappedPnl / collateral) * 100 : 0;
            const closeState = (pos as any).closeState;
            const isClosing = closeState === "close_tx_submitted";
            const isAwaitingFill = closeState === "close_order_working";
            const isPendingOpen = pos.status === "pending_open";
            const isTransitioning = isClosing || isAwaitingFill || isPendingOpen;

            const configuredSlBps = stopLossBps ?? 50;
            const effectiveSlBps = leverage > 0
              ? Math.min(configuredSlBps, Math.floor((4 / (100 * leverage)) * 10000))
              : configuredSlBps;
            const isCapped = effectiveSlBps < configuredSlBps;

            const slPrice = pos.side === "long"
              ? pos.entryPrice * (1 - effectiveSlBps / 10000)
              : pos.entryPrice * (1 + effectiveSlBps / 10000);
            const tpBps = takeProfitBps ?? 0;
            const tpPrice = tpBps > 0
              ? (pos.side === "long"
                ? pos.entryPrice * (1 + tpBps / 10000)
                : pos.entryPrice * (1 - tpBps / 10000))
              : 0;

            let rangeProgress = 0.5;
            if (livePrice > 0 && pos.entryPrice > 0 && slPrice > 0) {
              const tpRef = tpBps > 0 ? tpPrice : (pos.side === "long"
                ? pos.entryPrice * (1 + configuredSlBps * 3 / 10000)
                : pos.entryPrice * (1 - configuredSlBps * 3 / 10000));
              rangeProgress = pos.side === "long"
                ? (livePrice - slPrice) / (tpRef - slPrice)
                : (slPrice - livePrice) / (slPrice - tpRef);
              rangeProgress = Math.max(0.01, Math.min(0.99, rangeProgress));
            }

            const openedAt = (pos as any).openedAt;
            const durationStr = openedAt ? formatDuration(new Date(openedAt)) : "";
            const priceMoveFromEntry = pos.entryPrice > 0
              ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 10000
              : 0;
            const isLong = pos.side === "long";
            const markColor = (isLong ? priceMoveFromEntry >= 0 : priceMoveFromEntry <= 0) ? "text-emerald-500" : "text-red-500";

            return (
              <div
                key={pos.id}
                className={`rounded-lg border p-3 space-y-2.5 transition-colors ${isTransitioning ? "border-amber-500/30 bg-amber-500/5" : "border-border/30 bg-card/50"}`}
                data-testid={`collateral-row-${pos.id}`}
              >
                {isPendingOpen && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[8px] animate-pulse" data-testid={`pending-open-indicator-${pos.id}`}>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />Opening... verifying on-chain
                  </div>
                )}
                {isClosing && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[8px] animate-pulse" data-testid={`closing-indicator-${pos.id}`}>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />Closing... transaction submitted
                  </div>
                )}
                {isAwaitingFill && (
                  <div className="flex items-center gap-1.5 text-amber-400 text-[8px] animate-pulse" data-testid={`awaiting-fill-indicator-${pos.id}`}>
                    <Clock className="h-2.5 w-2.5" />Awaiting fill... order working
                  </div>
                )}

                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`text-[11px] px-2.5 py-0.5 font-bold border ${isLong ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15" : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/15"}`}
                    >
                      {isLong ? <TrendingUp className="h-3 w-3 mr-1 inline" /> : <TrendingDown className="h-3 w-3 mr-1 inline" />}
                      {pos.side.toUpperCase()}
                    </Badge>
                    {durationStr && (
                      <span className="text-[8px] text-muted-foreground/60 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{durationStr}
                      </span>
                    )}
                  </div>
                  <div className={`text-right shrink-0 ${cappedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    <p className="text-base font-mono font-bold leading-tight" data-testid={`pnl-value-${pos.id}`}>
                      {cappedPnl >= 0 ? "+" : ""}{cappedPnl.toFixed(4)}
                    </p>
                    <p className="text-[8px] opacity-70">
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}% collateral
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1">
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Collateral</p>
                    <p className="text-[11px] font-mono font-semibold">{collateral.toFixed(3)}</p>
                    <p className="text-[7px] text-muted-foreground">{pos.sizeSui.toFixed(1)} notional</p>
                  </div>
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Entry</p>
                    <p className="text-[11px] font-mono font-semibold">${pos.entryPrice.toFixed(4)}</p>
                    <p className="text-[7px] text-muted-foreground">{leverage}x leverage</p>
                  </div>
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Mark</p>
                    <p className={`text-[11px] font-mono font-semibold ${markColor}`}>
                      ${livePrice > 0 ? livePrice.toFixed(4) : "—"}
                    </p>
                    <p className={`text-[7px] ${(isLong ? priceMoveFromEntry >= 0 : priceMoveFromEntry <= 0) ? "text-emerald-500/70" : "text-red-500/70"}`}>
                      {priceMoveFromEntry >= 0 ? "+" : ""}{priceMoveFromEntry.toFixed(1)}bp
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[7px]">
                    <span className={`flex items-center gap-0.5 ${isCapped ? "text-amber-400" : "text-red-400/80"}`}>
                      <Shield className="h-2 w-2" />
                      {isCapped ? "Eff. " : ""}SL {effectiveSlBps}bp · ${slPrice.toFixed(4)}
                    </span>
                    {tpBps > 0 ? (
                      <span className="flex items-center gap-0.5 text-emerald-400/80">
                        ${tpPrice.toFixed(4)} · {tpBps}bp TP
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40">no TP</span>
                    )}
                  </div>
                  <div className="relative h-2 rounded-full bg-card/80 overflow-hidden">
                    <div
                      className="absolute inset-0 rounded-full"
                      style={{ background: "linear-gradient(to right, rgba(239,68,68,0.6), rgba(251,191,36,0.4) 45%, rgba(52,211,153,0.6))" }}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-2.5 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)] transform -translate-x-1/2 transition-all duration-700"
                      style={{ left: `${rangeProgress * 100}%` }}
                    />
                  </div>
                  {isCapped && (
                    <p className="text-[7px] text-amber-400/80">
                      Config {configuredSlBps}bp → {effectiveSlBps}bp effective at {leverage}x (4% max loss cap)
                    </p>
                  )}
                </div>

                {pos.txDigest && !pos.txDigest.startsWith("recovered_") && !pos.txDigest.startsWith("reopened_") && !pos.txDigest.startsWith("sim_") && (
                  <div className="flex items-center gap-1 text-[7px] pt-1 border-t border-border/10">
                    <span className="text-muted-foreground/50">Open TX:</span>
                    <TxLink txDigest={pos.txDigest} />
                  </div>
                )}
              </div>
            );
          })}
          {untrackedPositions.map((ocp) => {
            const livePrice = activity?.liveSuiPrice || 0;
            const pnl = livePrice > 0 && ocp.entryPrice > 0
              ? (ocp.side === "long"
                ? (livePrice - ocp.entryPrice) * ocp.size / livePrice
                : (ocp.entryPrice - livePrice) * ocp.size / livePrice)
              : 0;
            const cappedPnl = Math.max(-ocp.collateral, pnl);
            const pnlPct = ocp.collateral > 0 ? (cappedPnl / ocp.collateral) * 100 : 0;

            return (
              <div key={`untracked-${ocp.positionId}`} className="rounded-lg bg-blue-500/5 p-3 border border-blue-500/20 space-y-2" data-testid={`collateral-row-untracked-${ocp.positionId}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge className={`text-[11px] px-2.5 py-0.5 font-bold border ${ocp.side === "long" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15" : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/15"}`}>
                      {ocp.side === "long" ? <TrendingUp className="h-3 w-3 mr-1 inline" /> : <TrendingDown className="h-3 w-3 mr-1 inline" />}
                      {ocp.side.toUpperCase()}
                    </Badge>
                  </div>
                  <div className={`text-right shrink-0 ${cappedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    <p className="text-base font-mono font-bold leading-tight">
                      {cappedPnl >= 0 ? "+" : ""}{cappedPnl.toFixed(4)}
                    </p>
                    <p className="text-[8px] opacity-70">{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}% collateral</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Collateral</p>
                    <p className="text-[11px] font-mono font-semibold">{ocp.collateral.toFixed(3)}</p>
                    <p className="text-[7px] text-muted-foreground">{ocp.size.toFixed(1)} notional</p>
                  </div>
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Entry</p>
                    <p className="text-[11px] font-mono font-semibold">${ocp.entryPrice.toFixed(4)}</p>
                  </div>
                  <div className="rounded bg-card/60 p-1.5 text-center">
                    <p className="text-[7px] text-muted-foreground">Mark</p>
                    <p className="text-[11px] font-mono font-semibold">${livePrice > 0 ? livePrice.toFixed(4) : "—"}</p>
                  </div>
                </div>
                <div className="text-[7px] text-blue-400 flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                  Recovering on-chain position — auto-syncing (~60s)
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingOrders.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-amber-400 uppercase tracking-wider flex items-center gap-1">
            <Clock className="h-3 w-3" />Pending Orders (Awaiting Match)
          </p>
          {pendingOrders.map((order: any) => (
            <div key={order.orderId} className="flex items-center gap-2 rounded bg-amber-500/5 px-2.5 py-1.5 border border-amber-500/10" data-testid={`pending-order-${order.orderId}`}>
              <Badge variant={order.direction === "long" ? "default" : "destructive"} className="text-[8px] px-1 py-0 shrink-0">
                {order.direction.toUpperCase()}
              </Badge>
              <span className="text-[9px] font-mono flex-1">{order.collateral.toFixed(2)} SUI collateral</span>
              <span className="text-[8px] font-mono text-amber-400/60">#{order.orderId}</span>
              <span className="text-[8px] text-muted-foreground">{order.ageSeconds}s ago</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalsPanel({ signals }: { signals: Signal[] }) {
  if (!signals || signals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <SignalIcon className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No signals recorded</p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5" data-testid="signals-panel">
      {signals.map((sig) => (
        <div key={sig.id} className="flex items-center gap-2 rounded px-2.5 py-1.5 bg-card/30">
          {sig.signal === "long" ? (
            <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
          ) : sig.signal === "short" ? (
            <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
          ) : (
            <Minus className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className={`text-[10px] font-bold uppercase w-10 shrink-0 ${sig.signal === "long" ? "text-emerald-500" : sig.signal === "short" ? "text-red-500" : "text-muted-foreground"}`}>
            {sig.signal}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground">${sig.price.toFixed(4)}</span>
          <span className="text-[9px] font-mono text-muted-foreground ml-auto shrink-0">
            RSI:{sig.rsi.toFixed(0)}
          </span>
          <span className="text-[8px] text-muted-foreground/50 shrink-0">
            {sig.createdAt ? new Date(sig.createdAt).toLocaleTimeString() : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

const BUNDLE_STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-yellow-500", label: "Pending" },
  executing: { icon: PlayCircle, color: "text-blue-500", label: "Executing" },
  completed: { icon: CheckCircle2, color: "text-emerald-500", label: "Completed" },
  recorded: { icon: CheckCircle2, color: "text-teal-500", label: "Recorded" },
  rejected: { icon: XOctagon, color: "text-orange-500", label: "Rejected" },
  failed: { icon: XOctagon, color: "text-red-500", label: "Failed" },
  expired: { icon: Timer, color: "text-muted-foreground", label: "Expired" },
};

function BundlesPanel({ agentId, suiPrice }: { agentId: string; suiPrice: number }) {
  const { data: bundles, isLoading } = useQuery<InstructionBundleRecord[]>({
    queryKey: ["/api/bundles", agentId, "latest"],
    refetchInterval: 5000,
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  if (!bundles || bundles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Package className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">No execution bundles</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Created when the agent detects actionable signals</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="bundles-panel">
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(bundles.reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {} as Record<string, number>)).map(([status, count]) => {
          const config = BUNDLE_STATUS_CONFIG[status] || BUNDLE_STATUS_CONFIG.pending;
          const Icon = config.icon;
          return (
            <Badge key={status} variant="outline" className="text-[8px] gap-0.5">
              <Icon className={`h-2 w-2 ${config.color}`} />{config.label}: {count}
            </Badge>
          );
        })}
      </div>

      <div className="space-y-1">
        {bundles.slice(0, 15).map((bundle) => {
          const config = BUNDLE_STATUS_CONFIG[bundle.status] || BUNDLE_STATUS_CONFIG.pending;
          const StatusIcon = config.icon;
          const actions = (bundle.actions as any[]) || [];

          return (
            <div key={bundle.id} className="rounded bg-card/30 px-2.5 py-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <StatusIcon className={`h-3 w-3 ${config.color} shrink-0`} />
                  <span className="text-[9px] font-mono truncate" data-testid={`text-bundle-id-${bundle.id}`}>
                    {bundle.bundleId.slice(0, 8)}
                  </span>
                  {actions.map((action: any, i: number) => (
                    <Badge key={i} variant="outline" className="text-[8px] gap-0.5">
                      {action.type === "OPEN" && (
                        <>{action.side === "LONG" ? <TrendingUp className="h-2 w-2 text-emerald-500" /> : <TrendingDown className="h-2 w-2 text-red-500" />}{action.side} {action.leverage}x</>
                      )}
                      {action.type === "CLOSE" && <><XCircle className="h-2 w-2" />Close</>}
                      {action.type === "SET_SLTP" && "SL/TP"}
                      {action.type === "NOOP" && (action.reason || "Skip")}
                    </Badge>
                  ))}
                </div>
                <Badge
                  variant={bundle.status === "completed" || bundle.status === "recorded" ? "default" : bundle.status === "failed" || bundle.status === "rejected" ? "destructive" : "secondary"}
                  className="text-[7px]"
                  data-testid={`badge-bundle-status-${bundle.id}`}
                >
                  {config.label}
                </Badge>
              </div>

              {(bundle as any).executionError && (bundle.status === "rejected" || bundle.status === "failed") && (
                <p className="text-[8px] text-red-400 bg-red-500/10 rounded px-2 py-1 font-mono break-all" data-testid={`text-bundle-error-${bundle.id}`}>
                  {(bundle as any).executionError}
                </p>
              )}

              <span className="text-[8px] text-muted-foreground/50">
                {bundle.createdAt ? new Date(bundle.createdAt).toLocaleString() : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WithdrawDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [fundingAmount, setFundingAmount] = useState("");
  const [savingsAmount, setSavingsAmount] = useState("");
  const [withdrawStatus, setWithdrawStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number; savingsOnChainSui: number; savingsWalletAddress: string | null }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agent.id}/on-chain-balance`);
      if (!res.ok) return { onChainSui: 0, dbBalance: agent.balance, savingsOnChainSui: 0, savingsWalletAddress: null };
      return res.json();
    },
    enabled: open,
    refetchInterval: open ? 12000 : false,
  });

  const gasBudgetSui = 0.01;
  const onChainSui = onChainData?.onChainSui ?? 0;
  const savingsOnChainSui = onChainData?.savingsOnChainSui ?? 0;
  const maxFunding = Math.max(0, onChainSui - gasBudgetSui);
  const maxSavings = Math.max(0, savingsOnChainSui - gasBudgetSui);
  const hasSavings = !!onChainData?.savingsWalletAddress;

  const fundingAmt = parseFloat(fundingAmount) || 0;
  const savingsAmt = parseFloat(savingsAmount) || 0;

  function buildWithdrawSource(): { source: "funding" | "savings" | "both"; amount?: number; savingsAmount?: number } {
    const hasFunding = fundingAmt > 0;
    const hasSav = savingsAmt > 0;
    if (hasFunding && hasSav) return { source: "both", amount: fundingAmt, savingsAmount: savingsAmt };
    if (hasFunding) return { source: "funding", amount: fundingAmt };
    if (hasSav) return { source: "savings", savingsAmount: savingsAmt };
    return { source: "funding" };
  }

  function setAllMax() {
    setFundingAmount(maxFunding > 0 ? maxFunding.toFixed(4) : "");
    if (hasSavings) setSavingsAmount(maxSavings > 0 ? maxSavings.toFixed(4) : "");
  }

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      const { source, amount, savingsAmount: savAmt } = buildWithdrawSource();
      if ((amount ?? 0) <= 0 && (savAmt ?? 0) <= 0) throw new Error("Enter a withdrawal amount");
      if (!account?.address) throw new Error("Connect your wallet first");
      if (amount && amount > maxFunding + 0.001) throw new Error(`Funding amount exceeds max withdrawable (${maxFunding.toFixed(4)} SUI)`);
      if (savAmt && savAmt > maxSavings + 0.001) throw new Error(`Savings amount exceeds max withdrawable (${maxSavings.toFixed(4)} SUI)`);

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setWithdrawStatus("signing");
      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute({ transaction: tx }, { onSuccess: (d) => resolve(d), onError: (e) => reject(e) });
      });
      if (!result.digest) throw new Error("Transaction signing failed");

      setWithdrawStatus("verifying");
      const verification = await waitForFinalized(result.digest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setWithdrawStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/withdraw`, {
        source,
        amount: amount ?? undefined,
        savingsAmount: savAmt ?? undefined,
        toAddress: account.address,
        authTxDigest: result.digest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.amount > 0) parts.push(`${data.amount.toFixed(4)} SUI from funding`);
      if (data.savingsAmount > 0) parts.push(`${data.savingsAmount.toFixed(4)} SUI from savings`);
      toast({ title: "Withdrawal successful", description: `${parts.join(" + ")} sent to your wallet.` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "positions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "on-chain-balance"] });
      onOpenChange(false);
      setFundingAmount("");
      setSavingsAmount("");
      setWithdrawStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Withdrawal failed", description: err.message, variant: "destructive" });
      setWithdrawStatus("idle");
    },
  });

  const statusLabel = withdrawStatus === "signing" ? "Approve in wallet..." : withdrawStatus === "verifying" ? "Verifying on-chain..." : withdrawStatus === "processing" ? "Processing..." : null;
  const canWithdraw = fundingAmt > 0 || savingsAmt > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Withdraw from {agent.name}</DialogTitle>
          <DialogDescription>Withdraw SUI from either or both wallets to your connected wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Funding Wallet */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Funding Wallet</span>
              <span className="text-xs font-mono text-muted-foreground">{onChainSui.toFixed(4)} SUI on-chain</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                max={maxFunding}
                value={fundingAmount}
                onChange={(e) => setFundingAmount(e.target.value)}
                placeholder={`Max ${maxFunding.toFixed(4)}`}
                data-testid="input-withdraw-funding-amount"
              />
              <Button variant="outline" size="sm" onClick={() => setFundingAmount(maxFunding > 0 ? maxFunding.toFixed(4) : "")} data-testid="button-withdraw-funding-max">
                Max
              </Button>
            </div>
          </div>

          {/* Savings Wallet */}
          {hasSavings && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Savings Wallet</span>
                <span className="text-xs font-mono text-muted-foreground">{savingsOnChainSui.toFixed(4)} SUI on-chain</span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max={maxSavings}
                  value={savingsAmount}
                  onChange={(e) => setSavingsAmount(e.target.value)}
                  placeholder={`Max ${maxSavings.toFixed(4)}`}
                  data-testid="input-withdraw-savings-amount"
                />
                <Button variant="outline" size="sm" onClick={() => setSavingsAmount(maxSavings > 0 ? maxSavings.toFixed(4) : "")} data-testid="button-withdraw-savings-max">
                  Max
                </Button>
              </div>
            </div>
          )}

          {/* Withdraw All shortcut */}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs border-dashed"
            onClick={setAllMax}
            data-testid="button-withdraw-all-max"
          >
            Set All to Max ({(maxFunding + (hasSavings ? maxSavings : 0)).toFixed(4)} SUI total)
          </Button>

          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-withdraw-cancel">Cancel</Button>
          <Button
            onClick={() => withdrawMutation.mutate()}
            disabled={withdrawMutation.isPending || !account?.address || !canWithdraw}
            data-testid="button-withdraw-confirm"
          >
            {withdrawMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowDownToLine className="h-4 w-4 mr-1" />}
            Withdraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [refundStatus, setRefundStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number; mismatch: boolean }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    enabled: open,
    refetchInterval: false,
  });

  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet first");
      if (!onChainData || onChainData.onChainSui <= 0.002) throw new Error("On-chain balance too low for gas");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRefundStatus("signing");
      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          { onSuccess: (data) => resolve(data), onError: (err) => reject(err) }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRefundStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setRefundStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/refund`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Refund successful", description: `${data.amount.toFixed(4)} SUI returned. Tx: ${data.txDigest.slice(0, 12)}...` });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
      onOpenChange(false);
      setRefundStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Refund failed", description: err.message, variant: "destructive" });
      setRefundStatus("idle");
    },
  });

  const statusLabel = refundStatus === "signing" ? "Approve in wallet..." : refundStatus === "verifying" ? "Verifying..." : refundStatus === "processing" ? "Processing..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recover Funds from {agent.name}</DialogTitle>
          <DialogDescription>Return all remaining on-chain SUI to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">On-Chain Balance</span>
            <span className="text-sm font-mono font-bold">{onChainData ? `${onChainData.onChainSui.toFixed(4)} SUI` : "Loading..."}</span>
          </div>
          {onChainData?.mismatch && (
            <div className="flex items-center gap-2 text-xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />Balance mismatch detected
            </div>
          )}
          {onChainData && onChainData.onChainSui <= 0.002 && (
            <p className="text-xs text-red-500">Balance too low to cover gas for refund</p>
          )}
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-refund-cancel">Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => refundMutation.mutate()}
            disabled={refundMutation.isPending || !account?.address || !onChainData || onChainData.onChainSui <= 0.002}
            data-testid="button-refund-confirm"
          >
            {refundMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowDownToLine className="h-4 w-4 mr-1" />}
            Refund All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveCollateralDialog({ agent, open, onOpenChange }: { agent: AgentWithSignalAgent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [removeStatus, setRemoveStatus] = useState<"idle" | "signing" | "verifying" | "processing">("idle");
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const { data: onChainData } = useQuery<{ onChainSui: number; dbBalance: number; mismatch: boolean }>({
    queryKey: ["/api/agents", agent.id, "on-chain-balance"],
    enabled: open,
    refetchInterval: false,
  });

  const estimatedReceive = onChainData ? Math.max(onChainData.onChainSui - 0.02, 0) : agent.balance;

  const removeCollateralMutation = useMutation({
    mutationFn: async () => {
      if (!account?.address) throw new Error("Connect your wallet first");

      const authAmount = BigInt(1000);
      const tx = new Transaction();
      const [authCoin] = tx.splitCoins(tx.gas, [authAmount]);
      tx.transferObjects([authCoin], PROTOCOL_FEE_ADDRESS);

      setRemoveStatus("signing");
      const result = await new Promise<{ digest: string }>((resolve, reject) => {
        signAndExecute(
          { transaction: tx },
          { onSuccess: (data) => resolve(data), onError: (err) => reject(err) }
        );
      });

      const txDigest = result.digest;
      if (!txDigest) throw new Error("Transaction signing failed");

      setRemoveStatus("verifying");
      const verification = await waitForFinalized(txDigest);
      if (verification.status !== "success") throw new Error(verification.error || "Authorization failed on-chain");

      setRemoveStatus("processing");
      const res = await apiRequest("POST", `/api/agents/${agent.id}/remove-collateral`, {
        toAddress: account.address,
        authTxDigest: txDigest,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.withdrawFailed) {
        toast({ title: "Transfer failed", description: "Positions closed but on-chain transfer failed. Try Withdraw instead.", variant: "destructive" });
      } else {
        const desc = [
          data.closedPositions > 0 ? `Closed ${data.closedPositions} position(s)` : "",
          data.withdrawnAmount > 0 ? `Withdrew ${data.withdrawnAmount.toFixed(4)} SUI` : "",
        ].filter(Boolean).join(". ");
        toast({ title: "Collateral removed", description: desc });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/rewards/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      onOpenChange(false);
      setRemoveStatus("idle");
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
      setRemoveStatus("idle");
    },
  });

  const statusLabel = removeStatus === "signing" ? "Approve in wallet..." : removeStatus === "verifying" ? "Verifying..." : removeStatus === "processing" ? "Closing positions & withdrawing..." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove All Collateral</DialogTitle>
          <DialogDescription>Closes all positions, stops the agent, and withdraws everything to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">You will receive</span>
            <span className="text-sm font-mono font-bold text-emerald-500">~{estimatedReceive.toFixed(4)} SUI</span>
          </div>
          <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-destructive">This will:</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>Close all open positions at market price</li>
                  <li>Stop the agent from trading</li>
                  <li>Transfer all remaining SUI to your wallet</li>
                </ul>
              </div>
            </div>
          </div>
          {statusLabel && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{statusLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-remove-cancel">Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => removeCollateralMutation.mutate()}
            disabled={removeCollateralMutation.isPending || !account?.address}
            data-testid="button-remove-confirm"
          >
            {removeCollateralMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
            Remove All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentDetail({ agent }: { agent: AgentWithSignalAgent }) {
  const livePrice = useLivePrice();
  const currentPrice = livePrice?.blended || 0;
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showRemoveCollateral, setShowRemoveCollateral] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const account = useCurrentAccount();
  const { toast } = useToast();
  const { subscribe } = useWS();

  useEffect(() => {
    const unsub = subscribe("positions:updated", (data: any) => {
      if (data?.agentId === agent.id) {
        queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "activity"] });
        queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id, "positions"] });
      }
    });
    return unsub;
  }, [agent.id, subscribe]);

  const { data: activity, isLoading } = useQuery<{
    positions: Position[];
    signals: Signal[];
    reasoning: any;
    liveSuiPrice: number;
    portfolioValue: number;
    onChainWalletSui: number;
    lockedCollateral: number;
    pendingOrderCollateral: number;
    totalUnrealizedPnl: number;
    liveWinRate: number;
    realizedGain: number;
    realizedLoss: number;
    pendingRewards: number;
    claimedRewards: number;
    reinvestedAmount: number;
    gasCosts: number;
    netDeposited: number;
    totalTrades: number;
    dbTradeCount: number;
    serverTotalPnl: number;
    pendingOrders: any[];
    chainDerived: {
      tradeCount: number;
      wins: number;
      losses: number;
      liquidations: number;
      winRate: number;
      totalPnl: number;
      realizedGain: number;
      realizedLoss: number;
      gasCosts: number;
      chainTrades: Array<{
        openDigest: string;
        closeDigest: string | null;
        collateral: number;
        returned: number;
        pnlSui: number;
        outcome: string;
        openTimestamp: string | null;
        closeTimestamp: string | null;
      }>;
    } | null;
    settlementReceived: number;
    keeperOnChainSettlement: number;
    collateralDeployed: number;
    forceSettledLoss?: number;
    forceSettledCollateral?: number;
    savingsSplitPct?: number;
    savingsBalance?: number;
    savingsWalletAddress?: string | null;
  }>({
    queryKey: ["/api/agents", agent.id, "activity"],
    refetchInterval: 8000,
  });

  const syncBalanceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/agents/${agent.id}/sync-balance`);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.synced) {
        toast({ title: "Balance synced", description: `${data.previousBalance.toFixed(4)} → ${data.newBalance.toFixed(4)} SUI` });
      } else {
        toast({ title: "Already in sync", description: data.message });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
    },
    onError: (err: any) => toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agent.id}/resume${walletParam}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Agent resumed" });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    },
    onError: (err: any) => toast({ title: "Resume failed", description: err.message, variant: "destructive" }),
  });

  const freeSuiMutation = useMutation({
    mutationFn: async () => {
      const walletParam = account?.address ? `?wallet=${account.address}` : "";
      const res = await apiRequest("POST", `/api/agents/${agent.id}/free-sui${walletParam}`, { walletAddress: account?.address });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "SUI Freed", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents", agent.id] });
    },
    onError: (err: any) => toast({ title: "Failed to free SUI", description: err.message, variant: "destructive" }),
  });

  const isRunning = agent.status === "running";
  const openPositions = activity?.positions?.filter((p: any) => p.status === "open" || p.status === "pending_open") || [];
  const hasOpenPositions = openPositions.length > 0;
  const closingPositions = (activity?.positions || []).filter((p: any) =>
    (p.status === "open" || p.status === "pending_open") &&
    (p.closeState === "close_tx_submitted" || p.closeState === "close_order_working")
  );
  const pendingOpenPositions = (activity?.positions || []).filter((p: any) => p.status === "pending_open");

  const { data: onChainPortfolio } = useQuery<{
    timestamp: string;
    agents: Array<{
      agentId: string;
      name: string;
      freeSui: number;
      positions: Array<{ positionId: string; side: string; size: number; collateral: number; entryPrice: number; markPrice: number; unrealizedPnl: number }>;
      totalLocked: number;
      pendingOrderCollateral: number;
      portfolioValue: number;
      totalUnrealizedPnl: number;
      netDeposited: number;
      retainedProfits: number;
      claimedRewards: number;
      pendingRewards?: number;
      cached: boolean;
      source?: string;
      settlingPositions?: Array<{ id: string; side: string; collateral: number; closeState: string }>;
      settlingCollateral?: number;
      isStabilized?: boolean;
      dataVerified?: boolean;
      verifiedAt?: string | null;
      verificationDiscrepancyPct?: number | null;
      savingsBalance?: number;
      savingsWalletAddress?: string | null;
    }>;
  }>({
    queryKey: ["/api/agents/on-chain-portfolio"],
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const chainData = onChainPortfolio?.agents?.find(a => a.agentId === agent.id);

  const rawOnChainWallet = chainData?.freeSui ?? 0;
  const activityLocked = activity?.lockedCollateral ?? 0;

  const chainPositions = chainData?.positions ?? [];
  const chainPositionCount = chainPositions.length;
  const chainPositionLocked = chainPositions.reduce((s: number, p: any) => s + (p.collateral ?? 0), 0);
  const rawLockedCollateral = chainPositionCount > 0
    ? Math.max(chainPositionLocked, activityLocked)
    : activityLocked;

  const rawPendingOrderCollateral = chainData?.pendingOrderCollateral ?? 0;
  const liveSavingsBalance = chainData?.savingsBalance ?? activity?.savingsBalance ?? 0;
  const liveSavingsWalletAddress = chainData?.savingsWalletAddress ?? activity?.savingsWalletAddress ?? null;
  const rawPortfolioValue = rawLockedCollateral > chainPositionLocked
    ? rawOnChainWallet + rawLockedCollateral + rawPendingOrderCollateral + liveSavingsBalance
    : (chainData?.portfolioValue ?? rawOnChainWallet + rawLockedCollateral + rawPendingOrderCollateral + liveSavingsBalance);
  const liveUnrealizedPnl = chainData?.totalUnrealizedPnl ?? 0;
  const settlingPositions = chainData?.settlingPositions ?? [];
  const settlingCollateral = chainData?.settlingCollateral ?? 0;
  const isServerStabilized = chainData?.isStabilized ?? false;
  const isAnyDbPositionClosing = (activity?.positions || []).some((p: any) =>
    (p.status === "open" || p.status === "pending_open") &&
    (p.closeState === "close_tx_submitted" || p.closeState === "close_order_working")
  );
  const lastHadLockedRef = useRef<number>(0);
  if (activityLocked >= 0.01) lastHadLockedRef.current = Date.now();
  const isPostCloseGrace = activityLocked < 0.01 && (Date.now() - lastHadLockedRef.current) < 20_000;
  const hasSettlingActivity = settlingPositions.length > 0 || isServerStabilized || isAnyDbPositionClosing || isPostCloseGrace;

  const onChainWallet = useStableValue(rawOnChainWallet, hasSettlingActivity);
  const liveLockedCollateral = useStableValue(rawLockedCollateral, hasSettlingActivity);
  const pendingOrderCollateral = useStableValue(rawPendingOrderCollateral, hasSettlingActivity);
  const livePortfolioValue = useStableValue(rawPortfolioValue, hasSettlingActivity);

  const realizedPnlFromPositions = (activity?.realizedGain || 0) + (activity?.realizedLoss || 0);
  const gasCosts = activity?.gasCosts || 0;
  const rewardsPaid = activity?.claimedRewards || 0;
  // Prefer chain-derived win rate when the on-chain scan covers all known trades (most accurate).
  // Fall back to DB-derived liveWinRate for agents with trade histories longer than the scan window.
  const chainCoversAllTrades = activity?.chainDerived && activity.chainDerived.tradeCount > 0 &&
    activity.chainDerived.tradeCount >= (activity.dbTradeCount || 0);
  const winRate = chainCoversAllTrades
    ? activity!.chainDerived!.winRate
    : (activity?.liveWinRate ?? agent.winRate);
  const effectiveTrades = activity?.totalTrades ?? agent.totalTrades;
  const rewardSharePct = agent.rewardSharePct ?? 50;

  const fees = agent.protocolFeePaid || 0;
  const dbDeposited = (agent.totalDeposited || 0) - fees;
  const netDeposited = chainData?.netDeposited ?? activity?.netDeposited ?? dbDeposited;
  const claimedRewardsOut = chainData?.claimedRewards ?? activity?.claimedRewards ?? 0;
  const pendingRewardsOut = activity?.pendingRewards ?? 0;
  const isSettling = settlingPositions.length > 0;
  // True PnL includes portfolio value + all rewards generated (claimed + pending in reward wallet)
  const liveTotalPnl = netDeposited > 0 ? (livePortfolioValue + claimedRewardsOut + pendingRewardsOut) - netDeposited : 0;

  const isAnyPositionTransitioning = (activity?.positions || []).some((p: any) =>
    p.closeState === "close_tx_submitted" ||
    p.closeState === "close_order_working" ||
    p.status === "pending_open"
  );
  const portfolioIsAdjusting = isSettling || isAnyPositionTransitioning || syncBalanceMutation.isPending;
  // Green only when the Portfolio Verifier Sub-Agent has confirmed data is fresh from RPC + consistent.
  // Blue for all other states: loading, cached, settling, adjusting — "uncertain but known".
  const portfolioIsVerified = (chainData?.dataVerified === true) && !isSettling && !isAnyPositionTransitioning && !syncBalanceMutation.isPending;
  const portfolioValueColor = portfolioIsVerified ? "text-emerald-500" : "text-blue-400";

  const computedValues = {
    onChainWallet,
    lockedCollateral: liveLockedCollateral,
    unrealizedPnl: liveUnrealizedPnl,
    pendingOrderCollateral,
    portfolioValue: livePortfolioValue,
    realizedPnl: realizedPnlFromPositions,
    gasCosts,
    rewardsPaid,
    netDeposited,
    openPositionCount: openPositions.length,
  };

  return (
    <div className="space-y-3" data-testid={`agent-detail-${agent.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isRunning ? "bg-primary/20" : "bg-muted"}`}>
            <Bot className={`h-4 w-4 ${isRunning ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold truncate" data-testid={`text-agent-name-${agent.id}`}>{agent.name}</h3>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted-foreground font-mono">{VENUE_LABELS[agent.venue] || agent.venue}</span>
              <Badge variant={isRunning ? "default" : "secondary"} className="text-[8px]">
                {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
                {agent.status}
              </Badge>
            </div>
          </div>
        </div>
        <button
          onClick={() => syncBalanceMutation.mutate()}
          disabled={syncBalanceMutation.isPending}
          className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
          title="Sync on-chain balance"
          data-testid="button-sync-balance"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncBalanceMutation.isPending ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Position status bar — always visible so users can see real open count and portfolio stability */}
      <div className="flex items-center justify-between rounded-lg bg-card/40 border border-border/20 px-3 py-1.5 text-[10px]" data-testid="agent-position-statusbar">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 font-medium text-muted-foreground">
            <Lock className="h-3 w-3 text-primary/70" />
            {(() => {
              const dbOpen = openPositions.length;
              const chainOpen = chainPositions.length;
              const displayed = Math.max(dbOpen, chainOpen);
              if (closingPositions.length > 0) {
                return (
                  <span data-testid="text-open-position-count">
                    <span className="text-foreground font-bold">{dbOpen}</span> open
                    <span className="text-amber-400 ml-1.5 animate-pulse">({closingPositions.length} closing)</span>
                  </span>
                );
              }
              if (pendingOpenPositions.length > 0) {
                return (
                  <span data-testid="text-open-position-count">
                    <span className="text-foreground font-bold">{displayed}</span> open
                    <span className="text-blue-400 ml-1.5 animate-pulse">({pendingOpenPositions.length} pending)</span>
                  </span>
                );
              }
              return (
                <span data-testid="text-open-position-count">
                  <span className={`font-bold ${displayed > 0 ? "text-foreground" : "text-muted-foreground"}`}>{displayed}</span>
                  <span className="ml-1">{displayed === 1 ? "position" : "positions"} open</span>
                </span>
              );
            })()}
          </span>
          {settlingPositions.length > 0 && (
            <span className="text-amber-400/80 animate-pulse">settling…</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`font-mono font-bold ${portfolioIsVerified ? "text-emerald-400" : portfolioIsAdjusting ? "text-amber-400" : "text-blue-400"}`} data-testid="text-statusbar-portfolio">
            {fmtSui(livePortfolioValue)} SUI
          </span>
          <span className={`text-[8px] ${portfolioIsVerified ? "text-emerald-400/60" : portfolioIsAdjusting ? "text-amber-400/60" : "text-blue-400/60"}`}>
            {portfolioIsVerified ? "✓" : portfolioIsAdjusting ? "~" : "est"}
          </span>
        </div>
      </div>

      {agent.status === "paused" && account?.address && (
        <div className={`${(agent as any).pausedBy === "system" ? "bg-amber-500/10 border border-amber-500/30" : "bg-red-500/10 border border-red-500/20"} rounded-lg p-2.5`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${(agent as any).pausedBy === "system" ? "text-amber-500" : "text-red-500"}`} />
              <div className="text-[10px] min-w-0">
                <p className={`font-medium ${(agent as any).pausedBy === "system" ? "text-amber-500" : "text-red-500"}`}>
                  {(agent as any).pausedBy === "system" ? "Auto-Paused by System" : "Agent Paused"}
                </p>
                {(agent as any).pausedReason ? (
                  <p className="text-muted-foreground leading-relaxed">{(agent as any).pausedReason}</p>
                ) : agent.lastExecutionError ? (
                  <p className="text-muted-foreground truncate">{agent.lastExecutionError}</p>
                ) : null}
                {(agent as any).pausedBy === "system" && (agent as any).estimatedResumeAt && (
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
            <Button size="sm" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending} data-testid="button-resume-agent">
              {resumeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5 mr-1" />}
              Resume
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Portfolio</p>
          <p className={`text-sm font-mono font-bold transition-colors duration-500 ${portfolioValueColor}`} data-testid="text-portfolio-value">
            {fmtSui(livePortfolioValue)}
          </p>
          <p className={`text-[8px] ${portfolioIsVerified ? "text-emerald-500/70" : "text-blue-400/70"}`}>
            {portfolioIsAdjusting ? "adjusting..." : portfolioIsVerified ? "verified ✓" : "SUI"}
          </p>
        </div>
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Total PnL</p>
          <p className={`text-sm font-mono font-bold transition-colors duration-500 ${
            portfolioIsAdjusting
              ? "text-amber-400"
              : liveTotalPnl > 0 ? "text-emerald-500"
              : liveTotalPnl < 0 ? "text-red-500"
              : ""
          }`} data-testid="text-total-pnl">
            {liveTotalPnl === 0 ? "0.00" : `${liveTotalPnl >= 0 ? "+" : ""}${liveTotalPnl.toFixed(2)}`}
          </p>
          {portfolioIsAdjusting && (
            <p className="text-[8px] text-amber-400 animate-pulse">
              {isSettling ? "settling..." : isAnyPositionTransitioning ? "pending..." : "syncing..."}
            </p>
          )}
          {!portfolioIsAdjusting && liveUnrealizedPnl !== 0 && (
            <p className={`text-[8px] ${liveUnrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {liveUnrealizedPnl >= 0 ? "+" : ""}{liveUnrealizedPnl.toFixed(2)} open
            </p>
          )}
        </div>
        <div className="rounded-lg bg-card/60 border border-border/30 p-2.5 text-center">
          <p className="text-[8px] text-muted-foreground mb-0.5">Win Rate</p>
          <p className="text-sm font-mono font-bold" data-testid="text-win-rate">{(winRate * 100).toFixed(0)}%</p>
          <p className="text-[8px] text-muted-foreground">{effectiveTrades} trades</p>
        </div>
      </div>

      <PageErrorBoundary label="FundStatus">
        <FundStatus agent={agent} positions={activity?.positions || []} activity={activity} computed={computedValues} settlingCount={settlingPositions.length} settlingPositionsList={settlingPositions} portfolioIsVerified={portfolioIsVerified} />
      </PageErrorBoundary>

      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Zap className="h-3 w-3" />
          Rewards ({rewardSharePct}% profit share)
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center">
            <p className="text-[8px] text-muted-foreground">Claimable</p>
            <p className="text-xs font-mono font-bold text-emerald-500" data-testid="text-pending-rewards">
              {(activity?.pendingRewards || 0).toFixed(4)}
            </p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" title="Actual on-chain savings wallet balance">
            <p className="text-[8px] text-muted-foreground">Saved</p>
            <p className="text-xs font-mono font-bold text-primary" data-testid="text-reinvested">
              {(activity?.savingsBalance ?? 0).toFixed(4)}
            </p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center">
            <p className="text-[8px] text-muted-foreground">Claimed</p>
            <p className="text-xs font-mono font-bold" data-testid="text-claimed-rewards">
              {(activity?.claimedRewards || 0).toFixed(4)}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/30 bg-card/40 p-3 space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Shield className="h-3 w-3" />
          Configuration
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-leverage">
            <p className="text-[8px] text-muted-foreground">Leverage</p>
            <p className="text-sm font-bold font-mono">{agent.leverage}x</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-max-position">
            <p className="text-[8px] text-muted-foreground">Max Coll</p>
            <p className="text-sm font-bold font-mono">{agent.maxQty}</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-retention">
            <p className="text-[8px] text-muted-foreground">Savings</p>
            <p className="text-sm font-bold font-mono text-emerald-400">{agent.savingsSplitPct ?? 10}%</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-stop-loss">
            <p className="text-[8px] text-muted-foreground">Stop Loss</p>
            <p className="text-sm font-bold font-mono text-red-500">{agent.stopLossBps}bp</p>
          </div>
          <div className="rounded bg-card/60 border border-border/20 p-2 text-center" data-testid="config-take-profit">
            <p className="text-[8px] text-muted-foreground">Take Profit</p>
            <p className="text-sm font-bold font-mono text-emerald-500">{agent.takeProfitBps ? `${agent.takeProfitBps}bp` : "---"}</p>
          </div>
        </div>
        <SignalModeToggle agent={agent} />
        <RetentionPctControl agent={agent} />
        <div className="space-y-1.5 pt-1 border-t border-border/20">
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
            <span>Max collateral loss: 25%</span>
            <span>Emergency close: 35%</span>
          </div>
          {agent.walletAddress && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground flex items-center gap-1">
                <Wallet className="h-2.5 w-2.5" />
                Funding
              </span>
              <span className="flex items-center gap-1 text-muted-foreground font-mono">
                {agent.walletAddress.slice(0, 6)}...{agent.walletAddress.slice(-4)}
                <CopyButton text={agent.walletAddress} />
              </span>
            </div>
          )}
          {liveSavingsWalletAddress && (
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-emerald-400/80 flex items-center gap-1">
                <PiggyBank className="h-2.5 w-2.5" />
                Savings
                {liveSavingsBalance > 0.001 && (
                  <span className="text-emerald-400 font-mono ml-1">{liveSavingsBalance.toFixed(3)} SUI</span>
                )}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground font-mono">
                {liveSavingsWalletAddress.slice(0, 6)}...{liveSavingsWalletAddress.slice(-4)}
                <CopyButton text={liveSavingsWalletAddress} />
              </span>
            </div>
          )}
        </div>
      </div>

      {account?.address && (isRunning || hasOpenPositions) && (agent.balance > 0 || hasOpenPositions) && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => freeSuiMutation.mutate()}
          disabled={freeSuiMutation.isPending}
          className="w-full border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          data-testid="button-free-sui"
        >
          {freeSuiMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Coins className="h-3.5 w-3.5 mr-1.5 shrink-0" />
          )}
          <span className="text-xs">{freeSuiMutation.isPending ? "Closing & stopping..." : hasOpenPositions ? "Free SUI (Close All & Stop)" : "Free SUI (Stop Agent)"}</span>
        </Button>
      )}

      {account?.address && (livePortfolioValue > 0 || agent.balance > 0 || hasOpenPositions) && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="destructive" size="sm" onClick={() => setShowRemoveCollateral(true)} className="w-full" data-testid="button-remove-collateral">
            <Unlock className="h-3.5 w-3.5 mr-1 shrink-0" /><span className="truncate text-xs">Remove All</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowWithdraw(true)} className="w-full" data-testid="button-withdraw-open">
            <ArrowDownToLine className="h-3.5 w-3.5 mr-1 shrink-0" /><span className="truncate text-xs">Withdraw</span>
          </Button>
        </div>
      )}

      {account?.address && agent.balance < 0.1 && (agent.totalDeposited || 0) > 1 && !hasOpenPositions && (
        <Button variant="outline" size="sm" onClick={() => setShowRefund(true)} className="w-full" data-testid="button-refund-open">
          <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />Recover Remaining Funds
        </Button>
      )}

      {account?.address && agent.balance <= 0 && (agent.totalDeposited || 0) <= 1 && agent.walletAddress && !hasOpenPositions && (
        <Button variant="outline" size="sm" onClick={() => setShowRefund(true)} className="w-full" data-testid="button-refund-open">
          <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />Recover Remaining Funds
        </Button>
      )}

      <WithdrawDialog agent={agent} open={showWithdraw} onOpenChange={setShowWithdraw} />
      <RefundDialog agent={agent} open={showRefund} onOpenChange={setShowRefund} />
      <RemoveCollateralDialog agent={agent} open={showRemoveCollateral} onOpenChange={setShowRemoveCollateral} />

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Tabs defaultValue="positions" className="w-full">
          <TabsList className="w-full grid grid-cols-4 gap-0.5">
            <TabsTrigger value="positions" className="text-[9px] px-1" data-testid="tab-positions">
              <Activity className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Positions</span>
            </TabsTrigger>
            <TabsTrigger value="thinking" className="text-[9px] px-1" data-testid="tab-thinking">
              <Brain className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Signals</span>
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-[9px] px-1" data-testid="tab-signals">
              <SignalIcon className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">History</span>
            </TabsTrigger>
            <TabsTrigger value="bundles" className="text-[9px] px-1" data-testid="tab-bundles">
              <Package className="h-3 w-3 mr-0.5 shrink-0" />
              <span className="text-[8px]">Exec</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="positions" className="mt-2">
            <PageErrorBoundary label="Positions">
              <PositionsPanel positions={activity?.positions || []} livePrice={activity?.liveSuiPrice || currentPrice} leverage={agent.leverage} agentId={agent.id} chainTrades={activity?.chainDerived?.chainTrades} pendingOrders={activity?.pendingOrders} untrackedPositions={activity?.untrackedOnChainPositions} stopLossBps={agent.stopLossBps} takeProfitBps={agent.takeProfitBps} />
            </PageErrorBoundary>
          </TabsContent>
          <TabsContent value="thinking" className="mt-2">
            <PageErrorBoundary label="Thinking">
              <ThinkingProcess agentId={agent.id} reasoning={activity?.reasoning} />
            </PageErrorBoundary>
          </TabsContent>
          <TabsContent value="signals" className="mt-2">
            <PageErrorBoundary label="Signals">
              <SignalsPanel signals={activity?.signals || []} />
            </PageErrorBoundary>
          </TabsContent>
          <TabsContent value="bundles" className="mt-2">
            <PageErrorBoundary label="Bundles">
              <BundlesPanel agentId={agent.id} suiPrice={activity?.liveSuiPrice || currentPrice} />
            </PageErrorBoundary>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

interface WalletSummary {
  wallet: string;
  totalDepositedGross: number;
  totalDepositedNet: number;
  totalFeesPaid: number;
  totalFreeBalance: number;
  totalLockedCollateral: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalClaimedVerified: number;
  totalPendingRewards: number;
  settlingCollateral: number;
  verifiedOpenPositions: number;
  verifiedClosedPositions: number;
  depositsCount: number;
  claimsCount: number;
  agentIds: string[];
}

function WalletSummaryPanel({
  address,
  agents,
  portfolioData,
}: {
  address?: string;
  agents: AgentWithSignalAgent[];
  portfolioData?: { agents: Array<{ agentId: string; portfolioValue: number; netDeposited: number; claimedRewards?: number; pendingRewards?: number; totalLocked?: number; dataVerified?: boolean; isStabilized?: boolean; settlingPositions?: unknown[] }> };
}) {
  // Hooks must come before any conditional returns
  const { data: rewardsSummary } = useQuery<{
    totalClaimable: number;
    totalClaimed: number;
    rewardWalletBalance: number;
    directlyClaimable: number;
  }>({
    queryKey: ["/api/rewards"],
    refetchInterval: 30000,
    staleTime: 25000,
    enabled: !!(agents && agents.length > 0),
  });

  if (!agents || agents.length === 0) return null;

  // Compute summary from portfolio data (includes locked collateral)
  let totalDepositedNet = 0;
  let totalPortfolioValue = 0;
  let hasLiveData = false;
  let allVerified = true;
  let anySettling = false;

  for (const agent of agents) {
    const portEntry = portfolioData?.agents?.find(p => p.agentId === agent.id);

    if (portEntry) {
      hasLiveData = true;
      totalPortfolioValue += portEntry.portfolioValue;
      totalDepositedNet += portEntry.netDeposited;
      if (!portEntry.dataVerified) allVerified = false;
      if (portEntry.isStabilized || (portEntry.settlingPositions?.length ?? 0) > 0) anySettling = true;
    } else {
      allVerified = false;
      const dbOpenLocked = Math.max(0, (agent as any).lockedCollateral || 0);
      totalPortfolioValue += Math.max(0, agent.balance) + dbOpenLocked;
      totalDepositedNet += (agent.totalDeposited || 0) - (agent.protocolFeePaid || 0);
    }
  }

  // Color system: green = verified on-chain, amber = settling/adjusting, blue = estimated
  const portfolioIsVerified = hasLiveData && allVerified && !anySettling;
  const portfolioIsAdjusting = anySettling;
  const valueColor = portfolioIsVerified ? "text-emerald-400" : portfolioIsAdjusting ? "text-amber-400" : "text-blue-400";
  const valueSubColor = portfolioIsVerified ? "text-emerald-400/60" : portfolioIsAdjusting ? "text-amber-400/60" : "text-blue-400/60";
  const valueLabel = portfolioIsVerified ? "✓ verified" : portfolioIsAdjusting ? "~ adjusting" : "est";

  // Rewards: directlyClaimable = actual on-chain reward wallet balance - 0.01 gas reserve
  const claimableRewards = rewardsSummary?.directlyClaimable ?? rewardsSummary?.totalClaimable ?? 0;

  // Total PnL = portfolio value vs net deposited (rewards tracked separately in Rewards tab)
  const liveTotalPnl = totalDepositedNet > 0
    ? totalPortfolioValue - totalDepositedNet
    : 0;
  const totalPnlColor = liveTotalPnl >= 0 ? "text-emerald-500" : "text-red-500";

  return (
    <div className="rounded-xl border border-border/40 bg-card/50 p-3 space-y-2.5" data-testid="card-wallet-summary">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${portfolioIsVerified ? "bg-emerald-500/15" : portfolioIsAdjusting ? "bg-amber-500/15" : "bg-primary/15"}`}>
            <Wallet className={`h-3.5 w-3.5 ${portfolioIsVerified ? "text-emerald-400" : portfolioIsAdjusting ? "text-amber-400" : "text-primary"}`} />
          </div>
          <div>
            <p className="text-xs font-semibold">My Portfolio</p>
            {address
              ? <p className="text-[9px] font-mono text-muted-foreground">{address.slice(0, 6)}...{address.slice(-4)}</p>
              : <p className="text-[9px] text-muted-foreground/60">{agents.length} agent{agents.length !== 1 ? "s" : ""} · session</p>
            }
          </div>
        </div>
        <div className="text-right">
          <p className={`text-base font-bold font-mono transition-colors duration-500 ${valueColor}`} data-testid="text-wallet-portfolio">
            {fmtSui(Math.max(0, totalPortfolioValue))}
          </p>
          <p className={`text-[8px] ${valueSubColor}`}>
            {valueLabel} · {agents.length} agent{agents.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Net Deposited</p>
          <p className="text-[11px] font-mono font-bold" data-testid="text-wallet-deposited">{totalDepositedNet.toFixed(2)}</p>
        </div>
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Total PnL</p>
          <p className={`text-[11px] font-mono font-bold transition-colors duration-500 ${portfolioIsAdjusting ? "text-amber-400" : totalPnlColor}`} data-testid="text-wallet-realized">
            {portfolioIsAdjusting ? "~" : (liveTotalPnl >= 0 ? "+" : "")}{liveTotalPnl.toFixed(2)}
          </p>
          <p className={`text-[6px] ${valueSubColor}`}>{!hasLiveData ? "loading…" : valueLabel}</p>
        </div>
        <div className="rounded p-1.5 text-center bg-card/60">
          <p className="text-[7px] text-muted-foreground">Rewards</p>
          <p className={`text-[11px] font-mono font-bold ${claimableRewards > 0 ? "text-emerald-500" : "text-muted-foreground"}`} data-testid="text-wallet-rewards">
            {claimableRewards.toFixed(2)}
          </p>
          <p className="text-[6px] text-muted-foreground/50">{claimableRewards > 0 ? "claimable now" : "none yet"}</p>
        </div>
      </div>

      <div className="flex items-center justify-between text-[8px] text-muted-foreground/60 pt-0.5 border-t border-border/20">
        <span>
          {agents.filter(a => a.status === "running").length} running · {agents.filter(a => a.status !== "running").length} stopped
        </span>
        <span>
          Win rate: {agents.length > 0
            ? ((agents.reduce((s, a) => s + (a.winRate || 0), 0) / agents.length) * 100).toFixed(0)
            : "0"}%
        </span>
      </div>
    </div>
  );
}

interface VerifierAgentStatus {
  agentId: string;
  agentName: string;
  verifiedAt: string;
  portfolioValue: number;
  freeSui: number;
  totalLocked: number;
  positionCount: number;
  isConsistent: boolean;
  discrepancyPct: number;
  source: "rpc" | "failed";
  error?: string;
}

interface VerifierStatus {
  running: boolean;
  startedAt: string;
  lastCycleAt: string | null;
  totalCycles: number;
  agents: VerifierAgentStatus[];
}

function PortfolioVerifierPanel() {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const { data: verifierStatus } = useQuery<VerifierStatus>({
    queryKey: ["/api/portfolio-verifier/status"],
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (agentId: string) => {
      const params = new URLSearchParams();
      if (account?.address) params.set("wallet", account.address);
      params.set("force", "true");
      try {
        await apiRequest("DELETE", `/api/agents/${agentId}?${params.toString()}`);
      } catch (err: any) {
        // If the agent is already gone from the DB (404), just remove it from
        // the verifier's in-memory state so the panel stops showing it.
        if (err?.message?.includes("404") || err?.status === 404) {
          await apiRequest("DELETE", `/api/portfolio-verifier/agents/${agentId}`);
          return;
        }
        throw err;
      }
    },
    onSuccess: (_data, agentId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio-verifier/status"] });
      toast({ title: "Agent removed", description: `${pendingDelete?.name ?? agentId} has been removed` });
      setPendingDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message || "Could not delete agent", variant: "destructive" });
      setPendingDelete(null);
    },
  });

  const verifyNowMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/portfolio-verifier/verify-now"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio-verifier/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
      toast({ title: "Verification triggered", description: "On-chain data refresh in progress" });
    },
    onError: () => {
      toast({ title: "Verify failed", description: "Could not contact the verifier", variant: "destructive" });
    },
  });

  const agents = verifierStatus?.agents ?? [];
  const allVerified = agents.length > 0 && agents.every(a => a.source === "rpc" && a.isConsistent);
  const anyFailed = agents.some(a => a.source === "failed" || !a.isConsistent);
  const lastCycleMs = verifierStatus?.lastCycleAt ? Date.now() - new Date(verifierStatus.lastCycleAt).getTime() : null;
  const lastCycleLabel = lastCycleMs == null ? "never"
    : lastCycleMs < 60_000 ? `${Math.floor(lastCycleMs / 1000)}s ago`
    : `${Math.floor(lastCycleMs / 60_000)}m ago`;

  const statusColor = allVerified ? "text-emerald-400" : anyFailed ? "text-amber-400" : "text-blue-400";
  const StatusIcon = allVerified ? ShieldCheck : anyFailed ? ShieldAlert : ShieldCheck;

  return (
    <div className="rounded-xl border border-border/20 bg-card/30 p-3" data-testid="portfolio-verifier-panel">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${allVerified ? "bg-emerald-500/10" : anyFailed ? "bg-amber-500/10" : "bg-blue-500/10"}`}>
            <StatusIcon className={`h-3.5 w-3.5 ${statusColor}`} />
          </div>
          <div>
            <p className="text-[11px] font-semibold leading-none">Portfolio Verifier</p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-none">
              {verifierStatus?.running ? `Active · cycle ${verifierStatus.totalCycles} · ${lastCycleLabel}` : "Starting..."}
            </p>
          </div>
        </div>
        <button
          onClick={() => verifyNowMutation.mutate()}
          disabled={verifyNowMutation.isPending}
          className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/30 transition-colors"
          data-testid="button-verify-now"
        >
          <RefreshCw className={`h-2.5 w-2.5 ${verifyNowMutation.isPending ? "animate-spin" : ""}`} />
          Verify Now
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="flex items-center gap-1.5 py-1">
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          <p className="text-[9px] text-muted-foreground">Awaiting first verification cycle...</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {agents.map(a => {
            const isVerified = a.source === "rpc" && a.isConsistent;
            const isFailed = a.source === "failed";
            const ageMs = a.verifiedAt ? Date.now() - new Date(a.verifiedAt).getTime() : null;
            const ageLabel = ageMs == null ? "" : ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s ago` : `${Math.floor(ageMs / 60_000)}m ago`;

            return (
              <div key={a.agentId} className="flex items-center justify-between rounded-lg bg-background/40 border border-border/10 px-2.5 py-1.5" data-testid={`verifier-agent-${a.agentId}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isVerified ? "bg-emerald-400" : isFailed ? "bg-red-400" : "bg-amber-400"}`} />
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium truncate">{a.agentName}</p>
                    {a.error && <p className="text-[8px] text-red-400/80 truncate">{a.error.slice(0, 60)}</p>}
                    {!a.error && (
                      <p className="text-[8px] text-muted-foreground">
                        {a.positionCount} position{a.positionCount !== 1 ? "s" : ""} · {a.freeSui.toFixed(3)} free · {ageLabel}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!isFailed && a.discrepancyPct > 0.5 && (
                    <span className="text-[8px] text-amber-400 font-mono">{a.discrepancyPct.toFixed(1)}% Δ</span>
                  )}
                  <span className={`text-[9px] font-mono font-semibold ${isVerified ? "text-emerald-400" : isFailed ? "text-red-400" : "text-amber-400"}`}>
                    {isVerified ? "✓ verified" : isFailed ? "✗ failed" : "~ checking"}
                  </span>
                  <button
                    onClick={() => setPendingDelete({ id: a.agentId, name: a.agentName })}
                    className="p-1 rounded hover:bg-red-500/10 text-muted-foreground/40 hover:text-red-400 transition-colors"
                    title="Delete agent"
                    data-testid={`button-delete-verifier-${a.agentId}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-semibold text-foreground">"{pendingDelete?.name}"</span> and all its trading history, signals, and orders. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
              data-testid={`button-confirm-delete-${pendingDelete?.id}`}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function MyAgents() {
  usePageSEO({
    title: "My Agents",
    description: "View your active AI trading agents, positions, signals, and fund status",
  });

  const account = useCurrentAccount();
  const { subscribe } = useWS();

  const { data: agents, isLoading } = useQuery<AgentWithSignalAgent[]>({
    queryKey: ["/api/agents"],
    refetchInterval: 5000,
  });

  useEffect(() => {
    const unsub1 = subscribe("agent:updated", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agents/on-chain-portfolio"] });
    });
    const unsub2 = subscribe("agent:created", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub3 = subscribe("agent:deleted", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub4 = subscribe("agents:refresh", () => queryClient.invalidateQueries({ queryKey: ["/api/agents"] }));
    const unsub5 = subscribe("agent:balance-tick", (data: any) => {
      if (!data?.id) return;
      queryClient.setQueryData<AgentWithSignalAgent[]>(["/api/agents"], (old) => {
        if (!old) return old;
        return old.map((a) => a.id === data.id ? { ...a, balance: data.balance ?? a.balance } : a);
      });
    });
    // portfolio:tick — canonical portfolio state pushed from the backend state engine.
    // Immediately updates the on-chain-portfolio cache without waiting for an HTTP poll.
    const unsub6 = subscribe("portfolio:tick", (tick: any) => {
      if (!tick?.agentId) return;
      const dataVerified = tick.confidence === "green";
      const isStabilized = tick.confidence === "yellow" || tick.hasSettling;
      queryClient.setQueryData<{ agents: Array<any> }>(
        ["/api/agents/on-chain-portfolio"],
        (old) => {
          const existing = old?.agents ?? [];
          const idx = existing.findIndex((a: any) => a.agentId === tick.agentId);
          const updated = {
            ...(idx >= 0 ? existing[idx] : {}),
            agentId: tick.agentId,
            portfolioValue: tick.portfolioValue,
            freeSui: tick.walletSui,
            totalUnrealizedPnl: tick.unrealizedPnl,
            totalLocked: tick.lockedCollateral,
            savingsBalance: tick.savingsBalance,
            pendingOrderCollateral: tick.pendingOrderCollateral,
            dataVerified,
            isStabilized,
            confidence: tick.confidence,
            confidenceReason: tick.reason,
            _fromWS: true,
          };
          const next = idx >= 0
            ? existing.map((a: any) => a.agentId === tick.agentId ? updated : a)
            : [...existing, updated];
          return { ...(old ?? {}), agents: next };
        }
      );
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); };
  }, [subscribe]);

  const { data: summaryPortfolio } = useQuery<{
    agents: Array<{ agentId: string; portfolioValue: number; netDeposited: number; claimedRewards?: number; pendingRewards?: number; totalLocked?: number; dataVerified?: boolean; isStabilized?: boolean; settlingPositions?: unknown[] }>;
  }>({
    queryKey: ["/api/agents/on-chain-portfolio"],
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const allAgents = agents || [];
  const activeAgents = allAgents.filter((a) => a.status === "running");

  useEffect(() => {
    if (!selectedAgentId && activeAgents.length > 0) {
      setSelectedAgentId(activeAgents[0].id);
    } else if (!selectedAgentId && allAgents.length > 0) {
      setSelectedAgentId(allAgents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedAgent = allAgents.find((a) => a.id === selectedAgentId);

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-3xl mx-auto overflow-x-hidden" data-testid="page-my-agents">
      {allAgents.length > 0 && (
        <WalletSummaryPanel address={account?.address} agents={allAgents} portfolioData={summaryPortfolio} />
      )}

      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold tracking-tight">My Agents</h2>
          <p className="text-[10px] text-muted-foreground">Monitor positions, signals, and fund status</p>
        </div>
        {allAgents.length > 1 && (
          <Select value={selectedAgentId || ""} onValueChange={setSelectedAgentId}>
            <SelectTrigger className="w-[180px]" data-testid="select-agent">
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {allAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <div className="flex items-center gap-2">
                    {a.status === "running" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                    <span>{a.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <PortfolioVerifierPanel />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : allAgents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Bot className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <h3 className="text-sm font-medium mb-1">No agents deployed</h3>
            <p className="text-xs text-muted-foreground">Deploy an agent to start trading</p>
          </CardContent>
        </Card>
      ) : selectedAgent ? (
        <Card className="rounded-xl overflow-hidden">
          <CardContent className="p-3 pt-3">
            <AgentDetail agent={selectedAgent} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-xs text-muted-foreground">Select an agent to view details</p>
          </CardContent>
        </Card>
      )}

      {activeAgents.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Active</p>
            <p className="text-sm font-bold font-mono" data-testid="text-active-count">{activeAgents.length}</p>
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Balance</p>
            <p className="text-sm font-bold font-mono truncate">{fmtSui(allAgents.reduce((s, a) => s + a.balance, 0))}</p>
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">PnL</p>
            {(() => {
              const summaryPnl = summaryPortfolio?.agents?.reduce((total, sp) => {
                if (sp.netDeposited > 0) return total + (sp.portfolioValue + (sp.claimedRewards || 0) - sp.netDeposited);
                return total;
              }, 0) ?? allAgents.reduce((s, a) => s + a.totalPnl, 0);
              return (
                <p className={`text-sm font-bold font-mono truncate ${summaryPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-summary-pnl">
                  {summaryPnl.toFixed(2)}
                </p>
              );
            })()}
          </div>
          <div className="rounded-lg bg-card/40 border border-border/20 p-2 text-center">
            <p className="text-[7px] text-muted-foreground">Trades</p>
            <p className="text-sm font-bold font-mono">{allAgents.reduce((s, a) => s + a.totalTrades, 0)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
