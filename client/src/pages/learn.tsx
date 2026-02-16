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
        <TabsList className="flex-wrap gap-0.5" data-testid="tabs-learn">
          <TabsTrigger value="agents" className="text-[10px] sm:text-xs" data-testid="tab-agents">
            <Bot className="h-3.5 w-3.5 mr-1 shrink-0" />
            <span className="hidden sm:inline">AI </span>Agents
          </TabsTrigger>
          <TabsTrigger value="tech" className="text-[10px] sm:text-xs" data-testid="tab-tech">
            <Code2 className="h-3.5 w-3.5 mr-1 shrink-0" />
            Tech
          </TabsTrigger>
          <TabsTrigger value="architecture" className="text-[10px] sm:text-xs" data-testid="tab-architecture">
            <Layers className="h-3.5 w-3.5 mr-1 shrink-0" />
            Architecture
          </TabsTrigger>
          <TabsTrigger value="troubleshooting" className="text-[10px] sm:text-xs" data-testid="tab-troubleshooting">
            <AlertTriangle className="h-3.5 w-3.5 mr-1 shrink-0" />
            Troubleshooting
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
                <p className="text-[10px]">Agent monitors market, generates signal, builds transaction, executes on-chain.</p>
              </div>
            </div>
            <p className="mt-2">Automation reduces emotional trading, reaction lag, human error, and execution friction.</p>
          </Section>

          <Section icon={Activity} title="What Can an Agent Do?">
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Data</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Read price feeds</Badge>
                  <Badge variant="outline" className="text-[9px]">Monitor RSI, EMA, volatility</Badge>
                  <Badge variant="outline" className="text-[9px]">Track wallet balances</Badge>
                  <Badge variant="outline" className="text-[9px]">Track gas costs</Badge>
                  <Badge variant="outline" className="text-[9px]">Monitor positions</Badge>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Decision</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Generate long/short signals</Badge>
                  <Badge variant="outline" className="text-[9px]">Position sizing</Badge>
                  <Badge variant="outline" className="text-[9px]">Risk management</Badge>
                  <Badge variant="outline" className="text-[9px]">Avoid liquidation</Badge>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-medium text-foreground uppercase tracking-wider mb-1.5">Execution</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[9px]">Submit perp orders</Badge>
                  <Badge variant="outline" className="text-[9px]">Close positions</Badge>
                  <Badge variant="outline" className="text-[9px]">Claim rewards</Badge>
                  <Badge variant="outline" className="text-[9px]">Add/remove collateral</Badge>
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
              Instead of building raw blockchain logic from scratch, you use the SDK to interact safely. Blue Water Agents uses the Typus Finance SDK to construct and send trading transactions.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <Badge variant="outline" className="text-[9px]">Libraries</Badge>
              <Badge variant="outline" className="text-[9px]">Prewritten functions</Badge>
              <Badge variant="outline" className="text-[9px]">Auth helpers</Badge>
              <Badge variant="outline" className="text-[9px]">TX builders</Badge>
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
              <p className="text-foreground">Response: "$0.97"</p>
            </div>
            <p className="mt-2">APIs fetch price data, return balances, submit transactions, and pull order books. SDKs often wrap APIs.</p>
          </Section>

          <Section icon={Server} title="What is an RPC?">
            <p>
              <span className="text-foreground font-medium">RPC = Remote Procedure Call</span> - The gateway to the blockchain.
            </p>
            <p>RPC connects your app to a SUI full node, allowing you to read chain data, send transactions, check balances, and query smart contracts.</p>
            <div className="bg-muted rounded-md p-2.5 mt-2 space-y-1">
              <p className="text-[10px] font-medium text-foreground">RPC handles:</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[9px]">Gas estimation</Badge>
                <Badge variant="outline" className="text-[9px]">TX simulation</Badge>
                <Badge variant="outline" className="text-[9px]">State verification</Badge>
                <Badge variant="outline" className="text-[9px]">Balance queries</Badge>
              </div>
            </div>
            <p className="mt-2 text-foreground font-medium">Without RPC, agents cannot interact with the blockchain. If RPC fails, bundles fail, and agents can't trade.</p>
          </Section>

          <Section icon={FileText} title="What is a Smart Contract?">
            <p>
              A smart contract is on-chain code that holds logic, enforces rules, and executes deterministically. Perp exchanges use smart contracts to manage margin, track positions, calculate funding, and enforce liquidation.
            </p>
            <p>Blue Water Agents interact with Typus Finance smart contracts to open and close perpetual positions.</p>
          </Section>

          <Section icon={LinkIcon} title="Off-Chain vs On-Chain">
            <div className="grid grid-cols-2 gap-2 mt-1">
              <div className="bg-muted rounded-md p-2.5">
                <p className="text-[10px] font-medium text-foreground mb-1">Off-Chain</p>
                <div className="space-y-0.5 text-[10px]">
                  <p>AI logic</p>
                  <p>Strategy computation</p>
                  <p>Signal generation</p>
                  <p>Market analysis</p>
                </div>
              </div>
              <div className="bg-muted rounded-md p-2.5 border border-primary/20">
                <p className="text-[10px] font-medium text-primary mb-1">On-Chain</p>
                <div className="space-y-0.5 text-[10px]">
                  <p>Settlement</p>
                  <p>Position storage</p>
                  <p>Margin tracking</p>
                  <p>Liquidation logic</p>
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
                description="User funds agent wallet, grants session key permissions, and chooses risk profile (leverage, SL/TP, max collateral)."
              />
              <ConceptRow
                icon={Brain}
                label="Layer 2 - Strategy Agent (Off-Chain)"
                description="Reads SUI price, computes RSI, Connors RSI, EMA, DEMA, TEMA, MACD, and 5-Bar Reversal. Determines long/short with entry zone, stop loss, and take profit. Uses 7-condition scoring (4-of-7 required)."
              />
              <ConceptRow
                icon={Cpu}
                label="Layer 3 - Execution Agent"
                description="Validates minimum margin (10+ SUI per Typus), gas balance, and oracle sync. Builds transaction via SDK, sends to SUI RPC, confirms on-chain inclusion."
              />
              <ConceptRow
                icon={Globe}
                label="Layer 4 - Protocol Layer"
                description="Interacts with Typus Finance for perpetual trading on SUI mainnet with direct Move calls and Pyth oracle integration."
              />
              <ConceptRow
                icon={Activity}
                label="Layer 5 - Dashboard Layer"
                description="Displays SUI price, wallet balance, agent status, open positions, PnL, and risk exposure in real time."
              />
            </div>
          </Section>

          <Section icon={Database} title="Transaction Bundles">
            <p>Each trade bundle includes:</p>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <Badge variant="outline" className="text-[9px]">Order instruction</Badge>
              <Badge variant="outline" className="text-[9px]">Margin deposit</Badge>
              <Badge variant="outline" className="text-[9px]">Gas payment</Badge>
              <Badge variant="outline" className="text-[9px]">Signature</Badge>
            </div>
            <p className="mt-2">Bundles are rejected if gas is insufficient, oracle mismatches occur, or minimum contract size is not met.</p>
          </Section>

          <Section icon={Lock} title="Security Model">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[9px]">Encrypted keypairs</Badge>
              <Badge variant="outline" className="text-[9px]">Spending limits</Badge>
              <Badge variant="outline" className="text-[9px]">Gas buffer logic</Badge>
              <Badge variant="outline" className="text-[9px]">Dry-run simulation</Badge>
              <Badge variant="outline" className="text-[9px]">TX allowlist</Badge>
              <Badge variant="outline" className="text-[9px]">Circuit breaker</Badge>
              <Badge variant="outline" className="text-[9px]">Daily spend cap</Badge>
            </div>
          </Section>

          <Card>
            <CardContent className="py-4 text-center space-y-1">
              <p className="text-xs font-medium text-foreground">Blue Water Agents</p>
              <p className="text-[10px] text-muted-foreground">
                A modular autonomous trading infrastructure on SUI
              </p>
              <p className="text-[10px] text-muted-foreground font-mono">
                Developed by lifeguard.sui | Powered by Blue Water Digital
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="troubleshooting" className="mt-3 space-y-3">
          <Section icon={AlertTriangle} title="Why Agents Fail to Trade">
            <div className="space-y-2">
              {[
                { num: "1", text: "Gas below minimum (0.005 SUI hard stop)" },
                { num: "2", text: "Margin below contract requirement (10 SUI min on Typus)" },
                { num: "3", text: "Oracle price mismatch or stale data (>30s)" },
                { num: "4", text: "RPC latency or node unavailability" },
                { num: "5", text: "Dry-run simulation failure before execution" },
                { num: "6", text: "Slippage too tight (500bps buffer applied)" },
                { num: "7", text: "Max open positions reached (5 per agent)" },
                { num: "8", text: "Same-direction cooldown active (120s)" },
              ].map((item) => (
                <div key={item.num} className="flex items-start gap-2">
                  <span className="text-[10px] font-mono text-primary font-bold shrink-0 mt-0.5">{item.num}.</span>
                  <span className="text-[11px]">{item.text}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section icon={Shield} title="Circuit Breaker & Recovery">
            <p>
              After 3 consecutive failures, agents enter a 60-second cooldown (not permanent pause). They automatically recover and retry after the cooldown expires. Success resets the failure counter immediately.
            </p>
            <p className="mt-2">
              Daily spend cap: agents are auto-paused when daily failed gas exceeds 0.05 SUI or 10 failed transactions.
            </p>
          </Section>

          <Section icon={Radio} title="Oracle Integration">
            <p>
              Primary price source is Pyth Network's Hermes API for SUI/USD feed. Price is validated before every trade with a 30-second staleness guard. A 500bps slippage buffer is applied to prevent oracle mismatch errors.
            </p>
            <p className="mt-2">
              SUI-collateral trades on Typus require the SUI oracle passed twice as both oracle arguments. Oracle decimal precision is 8 digits.
            </p>
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
