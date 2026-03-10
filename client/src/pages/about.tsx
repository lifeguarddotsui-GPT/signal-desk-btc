import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePageSEO } from "@/lib/seo";
import {
  Waves,
  Cpu,
  Globe,
  Cable,
  Layers,
  Zap,
  Brain,
  Clock,
  Shield,
  TrendingUp,
  ArrowRight,
  Bot,
  Activity,
  Server,
  Code2,
  Lock,
  Target,
  Gauge,
} from "lucide-react";

function SectionCard({ icon: Icon, title, children, accentColor = "text-primary" }: { icon: any; title: string; children: React.ReactNode; accentColor?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className={`h-4 w-4 ${accentColor}`} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground leading-relaxed space-y-3">
        {children}
      </CardContent>
    </Card>
  );
}

function ConceptCard({ icon: Icon, title, subtitle, children }: { icon: any; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-md bg-muted/40 border border-border/20 space-y-2">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-md bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-xs font-bold text-foreground">{title}</p>
          <p className="text-[10px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="text-xs text-muted-foreground leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function FeatureRow({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}

function AdvantageCard({ icon: Icon, title, description }: { icon: any; title: string; description: string }) {
  return (
    <div className="p-3 rounded-md bg-muted/40 border border-border/20 space-y-1">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
        <p className="text-xs font-bold text-foreground">{title}</p>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

export default function About() {
  usePageSEO({
    title: "About Blue Water AI - How It Works",
    description: "Learn how Blue Water AI leverages SDKs, RPCs, and APIs to power autonomous AI trading agents on the SUI blockchain",
  });

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-4xl mx-auto" data-testid="page-about">
      <div className="space-y-1">
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-about-title">
          About Blue Water AI
        </h2>
        <p className="text-xs text-muted-foreground">
          Understanding the technology behind autonomous AI trading on SUI
        </p>
      </div>

      <SectionCard icon={Waves} title="What is Blue Water AI?">
        <p>
          Blue Water AI is an autonomous trading platform built on the <span className="font-medium text-foreground">SUI blockchain</span>. It deploys AI-powered agents that analyze market data in real-time, generate trading signals, and execute perpetual contract trades on Typus Finance without any manual intervention.
        </p>
        <p>
          Each agent uses a <span className="font-medium text-foreground">dual-architecture</span> design: an Execution Agent handles on-chain trade management, while a Signal Sub-Agent (the Triton Signal Engine) processes multi-timeframe market indicators to identify opportunities. Together, they operate 24/7, making decisions faster and more consistently than any human trader.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="outline" className="text-[10px]">SUI Mainnet</Badge>
          <Badge variant="outline" className="text-[10px]">Typus Perps</Badge>
          <Badge variant="outline" className="text-[10px]">AI-Powered</Badge>
          <Badge variant="outline" className="text-[10px]">Fully Autonomous</Badge>
          <Badge variant="outline" className="text-[10px]">On-Chain Verifiable</Badge>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ConceptCard icon={Code2} title="What is an SDK?" subtitle="Software Development Kit">
          <p>
            An SDK is a toolkit that gives developers pre-built functions for interacting with a platform. Blue Water uses the <span className="font-medium text-foreground">@mysten/sui SDK</span> to construct transactions, sign them with agent wallets, query on-chain data, and submit trades to the SUI network.
          </p>
          <p className="mt-1.5">
            Think of it like a toolbox: instead of building everything from scratch, the SDK provides ready-made wrenches and screwdrivers for blockchain operations.
          </p>
        </ConceptCard>

        <ConceptCard icon={Globe} title="What is an RPC?" subtitle="Remote Procedure Call">
          <p>
            An RPC is how our platform talks to the SUI blockchain. When an agent wants to check a wallet balance, submit a trade, or verify a transaction, it sends an RPC request to a SUI fullnode.
          </p>
          <p className="mt-1.5">
            It works like a phone call: our server "calls" the blockchain, asks a question or sends an instruction, and gets an answer back in milliseconds.
          </p>
        </ConceptCard>

        <ConceptCard icon={Cable} title="What is an API?" subtitle="Application Programming Interface">
          <p>
            An API defines how different software components communicate. Blue Water uses APIs everywhere: the frontend calls our backend API for agent data, the backend calls the Pyth Oracle API for prices, and the trading engine calls the Typus API for order execution.
          </p>
          <p className="mt-1.5">
            APIs are like restaurant menus: they list what you can order (endpoints) and what you'll get back (responses).
          </p>
        </ConceptCard>
      </div>

      <SectionCard icon={Layers} title="How Blue Water Leverages All This">
        <p className="font-medium text-foreground text-[11px]">The Technology Stack in Action</p>
        <p>
          Every trading decision flows through a precisely orchestrated pipeline of SDKs, RPCs, and APIs working together:
        </p>

        <div className="space-y-2 mt-1">
          <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30 border border-border/10">
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge className="text-[9px]">1</Badge>
              <Activity className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-foreground">Price Data Ingestion</p>
              <p className="text-[10px]">Pyth Oracle API streams real-time SUI/USDC prices. The market engine computes RSI, EMA, MACD, ADX, VWAP, and volume indicators across 5m, 15m, and 1h timeframes.</p>
            </div>
          </div>

          <div className="flex items-center gap-1 justify-center">
            <ArrowRight className="h-3 w-3 text-muted-foreground rotate-90" />
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30 border border-border/10">
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge className="text-[9px]">2</Badge>
              <Brain className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-foreground">Signal Generation</p>
              <p className="text-[10px]">The Triton Signal Engine evaluates weighted indicators, detects market regimes (TREND vs RANGE), and generates scored long/short signals with adaptive confidence thresholds.</p>
            </div>
          </div>

          <div className="flex items-center gap-1 justify-center">
            <ArrowRight className="h-3 w-3 text-muted-foreground rotate-90" />
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30 border border-border/10">
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge className="text-[9px]">3</Badge>
              <Cpu className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-foreground">Trade Execution</p>
              <p className="text-[10px]">The SUI SDK constructs the transaction, the RPC submits it to the blockchain, and the Typus DEX adapter handles order placement with dry-run preflights and gas management.</p>
            </div>
          </div>

          <div className="flex items-center gap-1 justify-center">
            <ArrowRight className="h-3 w-3 text-muted-foreground rotate-90" />
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30 border border-border/10">
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge className="text-[9px]">4</Badge>
              <Shield className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-medium text-foreground">Verification & Learning</p>
              <p className="text-[10px]">Every trade generates an on-chain transaction digest verified via RPC. The Learning Engine records outcomes and adjusts policy weights using EWMA + UCB algorithms for continuous improvement.</p>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={Bot} title="The Dual-Agent Architecture">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-3 rounded-md bg-muted/30 border border-border/10 space-y-1.5">
            <div className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-primary" />
              <p className="text-[11px] font-bold text-foreground">Execution Agent</p>
            </div>
            <div className="space-y-1 text-[10px]">
              <FeatureRow icon={Lock} text="Manages Ed25519 agent wallet keypair" />
              <FeatureRow icon={Target} text="Enforces stop-loss, take-profit, leverage limits" />
              <FeatureRow icon={Gauge} text="Adaptive position sizing based on signal strength" />
              <FeatureRow icon={Shield} text="3-tier anti-liquidation protection" />
              <FeatureRow icon={Zap} text="Circuit breaker with auto-recovery" />
            </div>
          </div>

          <div className="p-3 rounded-md bg-muted/30 border border-border/10 space-y-1.5">
            <div className="flex items-center gap-2">
              <Brain className="h-3.5 w-3.5 text-primary" />
              <p className="text-[11px] font-bold text-foreground">Triton Signal Engine</p>
            </div>
            <div className="space-y-1 text-[10px]">
              <FeatureRow icon={Activity} text="Multi-timeframe analysis (5m, 15m, 1h)" />
              <FeatureRow icon={Target} text="Regime detection: TREND vs RANGE via ADX" />
              <FeatureRow icon={Layers} text="8 weighted indicator scoring system" />
              <FeatureRow icon={Cpu} text="AUTO/AGGRESSIVE/PRECISION modes" />
              <FeatureRow icon={TrendingUp} text="UCB bandit learning for strategy optimization" />
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={Zap} title="Why AI Trading Beats Manual">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <AdvantageCard
            icon={Clock}
            title="24/7 Operation"
            description="AI agents never sleep. They monitor markets around the clock, catching opportunities in every timezone and session, including overnight moves that manual traders miss."
          />
          <AdvantageCard
            icon={Zap}
            title="Sub-Second Execution"
            description="From signal detection to on-chain trade submission in milliseconds. No hesitation, no second-guessing. Dry-run preflights ensure every transaction will succeed before submission."
          />
          <AdvantageCard
            icon={Brain}
            title="Regime Awareness"
            description="The Triton engine detects whether the market is trending or ranging and automatically adjusts its strategy. It switches between AGGRESSIVE and PRECISION modes based on real-time conditions."
          />
          <AdvantageCard
            icon={Shield}
            title="Emotion-Free Decisions"
            description="No fear, no greed, no FOMO. AI agents follow their signal scores and risk parameters exactly. Losing streaks trigger cooldowns, not panic sells or revenge trades."
          />
          <AdvantageCard
            icon={Target}
            title="Consistent Risk Management"
            description="Every trade has pre-defined stop-loss, take-profit, and leverage limits. Position sizing adapts to signal confidence. Three-tier anti-liquidation protection guards capital."
          />
          <AdvantageCard
            icon={TrendingUp}
            title="Continuous Learning"
            description="The Learning Engine records every trade outcome and adjusts strategy weights using EWMA + UCB algorithms. The system gets smarter with every trade, blocking unprofitable patterns automatically."
          />
        </div>
      </SectionCard>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="p-2 rounded-md bg-primary/10">
              <Waves className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-foreground" data-testid="text-about-cta">
                Ready to deploy your first AI agent?
              </p>
              <p className="text-[11px] text-muted-foreground">
                Start with as little as 1 SUI. Your agent will begin analyzing markets and executing trades autonomously on SUI mainnet.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px]">On-Chain Verifiable</Badge>
              <Badge variant="outline" className="text-[10px]">Non-Custodial</Badge>
              <Badge variant="outline" className="text-[10px]">Fully Autonomous</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
