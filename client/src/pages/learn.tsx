import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePageSEO } from "@/lib/seo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Bot,
  Brain,
  Cpu,
  Globe,
  Layers,
  Shield,
  Zap,
  Radio,
  ArrowRight,
  Code2,
  Database,
  AlertTriangle,
  Wallet,
  Activity,
  TrendingUp,
  Server,
  Link as LinkIcon,
  FileText,
  Lock,
  Target,
} from "lucide-react";

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-primary shrink-0" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground leading-relaxed space-y-2">
        {children}
      </CardContent>
    </Card>
  );
}

function ConceptRow({ icon: Icon, label, description }: { icon: any; label: string; description: string }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

export default function Learn() {
  usePageSEO({
    title: "What is an AI Agent? - Blue Water Agents",
    description: "Learn about AI agents, automation, SDKs, APIs, RPCs, and the architecture behind Blue Water Agents autonomous trading platform on SUI.",
  });

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-3xl mx-auto" data-testid="page-learn">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-learn-title">
          Core Concepts
        </h2>
        <p className="text-xs text-muted-foreground">Understanding AI agents, automation, and how Blue Water Agents works</p>
      </div>

      <Tabs defaultValue="agents">
        <TabsList className="w-full grid grid-cols-4" data-testid="tabs-learn">
          <TabsTrigger value="agents" className="text-[10px] sm:text-xs px-1 sm:px-3" data-testid="tab-agents">
            <Bot className="h-3 w-3 mr-0.5 sm:mr-1 shrink-0" />
            Agents
          </TabsTrigger>
          <TabsTrigger value="tech" className="text-[10px] sm:text-xs px-1 sm:px-3" data-testid="tab-tech">
            <Code2 className="h-3 w-3 mr-0.5 sm:mr-1 shrink-0" />
            Tech
          </TabsTrigger>
          <TabsTrigger value="architecture" className="text-[10px] sm:text-xs px-1 sm:px-3" data-testid="tab-architecture">
            <Layers className="h-3 w-3 mr-0.5 sm:mr-1 shrink-0" />
            <span className="hidden sm:inline">Architect</span><span className="sm:hidden">Arch</span>
          </TabsTrigger>
          <TabsTrigger value="troubleshooting" className="text-[10px] sm:text-xs px-1 sm:px-3" data-testid="tab-troubleshooting">
            <AlertTriangle className="h-3 w-3 mr-0.5 sm:mr-1 shrink-0" />
            <span className="hidden sm:inline">Troubleshoot</span><span className="sm:hidden">Help</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-3 space-y-3">
          <Section icon={Brain} title="What is an AI Agent?">
            <p>
              An AI Agent is a software entity that <span className="text-foreground font-medium">perceives</span> information (market data, wallet state),{" "}
              <span className="text-foreground font-medium">decides</span> based on rules or algorithms, and{" "}
              <span className="text-foreground font-medium">acts</span> autonomously (executes trades, sends transactions).
            </p>
            <p className="text-foreground font-medium">
              In simple terms: an AI Agent is a decision-making program that takes actions on your behalf.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">Rule-Based</p>
                <p className="text-[10px]">"If RSI {'<'} 30, go long"</p>
              </div>
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">Algorithmic</p>
                <p className="text-[10px]">EMA crossover strategies</p>
              </div>
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">ML-Driven</p>
                <p className="text-[10px]">Pattern recognition models</p>
              </div>
              <div className="bg-muted rounded-md p-2.5 border border-primary/20">
                <p className="text-[10px] font-medium text-primary mb-1">Multi-Agent (Blue Water)</p>
                <p className="text-[10px]">One agent analyzes, one executes</p>
              </div>
            </div>
          </Section>

          <Section icon={Target} title="How Blue Water Agents Trade">
            <p>
              Each agent uses the <span className="text-foreground font-medium">Triton Signal Engine</span>, a regime-aware
              system that detects whether the market is trending (ADX {'>'} 20) or ranging. It analyzes
              multi-timeframe data (5m decisions, 15m/1h confirmation) and generates weighted scores.
            </p>
            <p className="mt-1">
              Three signal modes are available:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1.5">
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">AGGRESSIVE</p>
                <p className="text-[10px]">Score 30+ to trade. Wider thresholds, more signals.</p>
              </div>
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">PRECISION</p>
                <p className="text-[10px]">Score 48+ to trade. Tighter filters, fewer but higher-quality entries.</p>
              </div>
              <div className="bg-muted rounded-md p-2.5 border border-primary/20">
                <p className="text-[10px] font-medium text-primary mb-1">AUTO (Default)</p>
                <p className="text-[10px]">Switches dynamically based on market conditions.</p>
              </div>
            </div>
            <p className="mt-2">
              Position sizing is adaptive: stronger signals (higher scores) open with more collateral
              (25-100% of max). Short loss cooldowns (30s per loss, 3min for 3+ streak) prevent
              revenge trading.
            </p>
          </Section>

          <Section icon={Zap} title="What is Automation?">
            <p>
              Automation means software performing tasks without manual human input each time.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">Manual Trading</p>
                <p className="text-[10px]">Log into exchange, choose size, sign transaction, confirm each step manually.</p>
              </div>
              <div className="bg-muted rounded-md p-2.5 border border-primary/20">
                <p className="text-[10px] font-medium text-primary mb-1">Automated (Blue Water)</p>
                <p className="text-[10px]">Agent monitors market, generates signal, builds transaction, executes on-chain, manages risk.</p>
              </div>
            </div>
            <p className="mt-2">Automation reduces emotional trading, reaction lag, human error, and execution friction.</p>
          </Section>

          <Section icon={Activity} title="What Can an Agent Do?">
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Data</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Read Pyth price feeds</Badge>
                  <Badge variant="outline" className="text-[9px]">Monitor RSI, EMA, ADX, ATR</Badge>
                  <Badge variant="outline" className="text-[9px]">Track wallet balances</Badge>
                  <Badge variant="outline" className="text-[9px]">Track gas costs</Badge>
                  <Badge variant="outline" className="text-[9px]">Multi-timeframe analysis</Badge>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Decision</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Regime detection (trend/range)</Badge>
                  <Badge variant="outline" className="text-[9px]">Weighted signal scoring</Badge>
                  <Badge variant="outline" className="text-[9px]">Adaptive position sizing</Badge>
                  <Badge variant="outline" className="text-[9px]">Anti-liquidation protection</Badge>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Execution</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Submit perp orders via Typus</Badge>
                  <Badge variant="outline" className="text-[9px]">Close with dry-run preflight</Badge>
                  <Badge variant="outline" className="text-[9px]">Detect liquidations on-chain</Badge>
                  <Badge variant="outline" className="text-[9px]">Recover orphaned orders</Badge>
                </div>
              </div>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="tech" className="mt-3 space-y-3">
          <Section icon={Code2} title="What is an SDK?">
            <p>
              <span className="text-foreground font-medium">SDK = Software Development Kit</span> - A toolbox developers use to build apps on a platform.
            </p>
            <p>
              Instead of building raw blockchain logic from scratch, you use the SDK to interact safely. Blue Water Agents uses the @mysten/sui SDK to construct and send trading transactions directly via Move calls to Typus Finance smart contracts.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <Badge variant="outline" className="text-[9px]">Libraries</Badge>
              <Badge variant="outline" className="text-[9px]">Prewritten functions</Badge>
              <Badge variant="outline" className="text-[9px]">TX builders</Badge>
              <Badge variant="outline" className="text-[9px]">Dry-run simulation</Badge>
            </div>
          </Section>

          <Section icon={Globe} title="What is an API?">
            <p>
              <span className="text-foreground font-medium">API = Application Programming Interface</span> - How software talks to other software.
            </p>
            <p>
              Think of it as a contract: "If I send this request, you send me this data."
            </p>
            <div className="bg-muted rounded-md p-2.5 mt-2 font-mono text-[10px]">
              <p className="text-muted-foreground">Request: "Give me SUI price."</p>
              <p className="text-foreground">Response: "$0.91"</p>
            </div>
            <p className="mt-2">APIs fetch price data, return balances, submit transactions, and pull order books. SDKs often wrap APIs.</p>
          </Section>

          <Section icon={Server} title="What is an RPC?">
            <p>
              <span className="text-foreground font-medium">RPC = Remote Procedure Call</span> - The gateway to the blockchain.
            </p>
            <p>RPC connects your app to a SUI full node, allowing you to read chain data, send transactions, check balances, and query smart contracts. Blue Water uses the SUI mainnet full node at fullnode.mainnet.sui.io.</p>
            <div className="bg-muted rounded-md p-2.5 mt-2 space-y-1">
              <p className="text-[10px] font-medium text-foreground">RPC handles:</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[9px]">Gas estimation</Badge>
                <Badge variant="outline" className="text-[9px]">TX simulation (dry-run)</Badge>
                <Badge variant="outline" className="text-[9px]">State verification</Badge>
                <Badge variant="outline" className="text-[9px]">Balance queries</Badge>
                <Badge variant="outline" className="text-[9px]">Event scanning</Badge>
              </div>
            </div>
            <p className="mt-2 text-foreground font-medium">Without RPC, agents cannot interact with the blockchain.</p>
          </Section>

          <Section icon={FileText} title="What is a Smart Contract?">
            <p>
              A smart contract is on-chain code that holds logic, enforces rules, and executes deterministically. Perp exchanges use smart contracts to manage margin, track positions, calculate funding, and enforce liquidation.
            </p>
            <p>Blue Water Agents interact with Typus Finance smart contracts via direct Move calls to create_trading_order, cancel_trading_order, and query positions.</p>
          </Section>

          <Section icon={LinkIcon} title="Off-Chain vs On-Chain">
            <div className="grid grid-cols-2 gap-2 mt-1">
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">Off-Chain</p>
                <div className="space-y-0.5 text-[10px]">
                  <p>Signal engine logic</p>
                  <p>Regime detection</p>
                  <p>Indicator computation</p>
                  <p>Risk management</p>
                  <p>Learning engine</p>
                </div>
              </div>
              <div className="bg-muted rounded-md p-2.5 border border-primary/20">
                <p className="text-[10px] font-medium text-primary mb-1">On-Chain</p>
                <div className="space-y-0.5 text-[10px]">
                  <p>Trade settlement</p>
                  <p>Position storage</p>
                  <p>Margin tracking</p>
                  <p>Liquidation logic</p>
                  <p>Balance verification</p>
                </div>
              </div>
            </div>
            <p className="mt-2 text-foreground font-medium">Blue Water Agents think off-chain and execute on-chain.</p>
          </Section>
        </TabsContent>

        <TabsContent value="architecture" className="mt-3 space-y-3">
          <Section icon={Layers} title="Architecture Overview">
            <div className="space-y-3">
              <ConceptRow
                icon={Wallet}
                label="Layer 1 - User Layer"
                description="User funds agent wallet, chooses signal mode (AGGRESSIVE/PRECISION/AUTO), and configures risk profile (leverage, SL/TP, min/max collateral)."
              />
              <ConceptRow
                icon={Brain}
                label="Layer 2 - Triton Signal Engine (Off-Chain)"
                description="Reads multi-timeframe price data. Detects market regime via ADX. Computes weighted signal score from RSI, EMA distance, volume, ADX, HTF alignment, MACD, VWAP, and RSI recovery. Adaptive position sizing based on score."
              />
              <ConceptRow
                icon={Cpu}
                label="Layer 3 - Execution Agent"
                description="Validates gas, margin, and oracle sync. Runs dry-run preflight. Builds transaction via SUI SDK, sends to RPC, confirms on-chain inclusion. Manages position lifecycle and close state machine."
              />
              <ConceptRow
                icon={Globe}
                label="Layer 4 - Protocol Layer (Typus Perps)"
                description="Keeper-based market orders on SUI mainnet via direct Move calls. Two-step position_id assignment. Pre-close existence verification. Terminal error detection (order_not_found, key_not_found)."
              />
              <ConceptRow
                icon={Activity}
                label="Layer 5 - Monitoring & Recovery"
                description="Position monitor, circuit breaker, daily spend cap, LiquidateEvent detection, orphaned order recovery, SUI flow analysis, and chain-derived PnL verification."
              />
            </div>
          </Section>

          <Section icon={Database} title="Transaction Flow">
            <p>Each trade follows this flow:</p>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <Badge variant="outline" className="text-[9px]">Signal generated</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">Size calculated</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">Dry-run preflight</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">On-chain TX</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">Keeper fill</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[9px]">Position resolved</Badge>
            </div>
            <p className="mt-2">Transactions are rejected if gas is insufficient, oracle mismatches, or dry-run fails.</p>
          </Section>

          <Section icon={Lock} title="Security Model">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[9px]">NaCl-encrypted keypairs</Badge>
              <Badge variant="outline" className="text-[9px]">Per-wallet TX queue</Badge>
              <Badge variant="outline" className="text-[9px]">Gas budget caps</Badge>
              <Badge variant="outline" className="text-[9px]">Dry-run simulation</Badge>
              <Badge variant="outline" className="text-[9px]">Pre-close verification</Badge>
              <Badge variant="outline" className="text-[9px]">Circuit breaker</Badge>
              <Badge variant="outline" className="text-[9px]">Daily spend cap</Badge>
              <Badge variant="outline" className="text-[9px]">Anti-liquidation (3-tier)</Badge>
            </div>
          </Section>

          <Card>
            <CardContent className="py-4 text-center space-y-1">
              <p className="text-xs font-medium text-foreground">Blue Water Agents</p>
              <p className="text-[10px] text-muted-foreground">
                A modular autonomous trading infrastructure on SUI
              </p>
              <p className="text-[10px] text-muted-foreground font-mono">
                Developed by lifeguard.sui | Powered by Blue Water Protocol LLC
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="troubleshooting" className="mt-3 space-y-3">
          <Section icon={AlertTriangle} title="Why Agents Fail to Trade">
            <div className="space-y-2">
              {[
                { num: "1", text: "Gas below minimum (0.005 SUI hard stop)" },
                { num: "2", text: "Margin below minimum collateral (0.2 SUI configurable)" },
                { num: "3", text: "Oracle price stale (>30s) or mismatch (5min cooldown)" },
                { num: "4", text: "RPC latency or node unavailability" },
                { num: "5", text: "Dry-run simulation failure before execution" },
                { num: "6", text: "Signal score below mode threshold (30 AGGRESSIVE, 48 PRECISION)" },
                { num: "7", text: "Loss cooldown active (30s per loss, 3min for 3+ streak)" },
                { num: "8", text: "Trade cooldown active (10s between trades)" },
                { num: "9", text: "Circuit breaker triggered (3 consecutive failures, 60s cooldown)" },
                { num: "10", text: "Daily spend cap reached (auto-pauses agent)" },
              ].map((item) => (
                <div key={item.num} className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">{item.num}.</span>
                  <span className="text-[11px]">{item.text}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section icon={Shield} title="Why Closes Fail">
            <div className="space-y-2">
              {[
                { label: "order_not_found", text: "Position was already liquidated or filled by Typus keeper. System detects this, checks on-chain, and settles as liquidated or closed." },
                { label: "key_not_found", text: "Stored position ID is an order_id, not a position_id. System attempts re-resolution from on-chain fill events and retries with corrected ID." },
                { label: "too_many_linked_orders", text: "Existing unfilled close orders block new ones. System deep-cancels linked orders via wallet history scan, then retries." },
                { label: "oracle_mismatch", text: "Pyth price too stale or diverged from Typus oracle. 5-minute cooldown before retry." },
              ].map((item) => (
                <div key={item.label} className="p-2 bg-muted/30 rounded-md">
                  <p className="text-[10px] font-medium text-foreground font-mono">{item.label}</p>
                  <p className="text-[10px] mt-0.5">{item.text}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section icon={Activity} title="Position Settlement">
            <p>
              When a position disappears from on-chain (order_not_found, key_not_found), the system:
            </p>
            <div className="space-y-1 mt-1.5">
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">1.</span>
                <span className="text-[11px]">Checks if position still exists on-chain via getPositions</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">2.</span>
                <span className="text-[11px]">Scans for LiquidateEvent in recent transactions</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">3.</span>
                <span className="text-[11px]">Checks wallet balance to determine if collateral was returned</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">4.</span>
                <span className="text-[11px]">Classifies as liquidated (collateral lost) or settled (collateral returned)</span>
              </div>
            </div>
          </Section>

          <Section icon={Radio} title="Oracle & Price Data">
            <p>
              Primary price source is Pyth Network's Hermes API for SUI/USD feed. Price is validated
              before every trade with a 30-second staleness guard. Oracle price precision is 8 decimal digits.
            </p>
            <p className="mt-2">
              SUI-collateral trades on Typus require the SUI oracle passed twice as both oracle arguments.
              Oracle mismatch errors trigger a 5-minute cooldown before retry to avoid burning gas.
            </p>
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
