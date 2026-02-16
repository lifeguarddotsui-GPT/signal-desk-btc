import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePageSEO } from "@/lib/seo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BookOpen,
  Layers,
  Coins,
  Code2,
  Shield,
  Bot,
  Radio,
  Zap,
  Database,
  Globe,
  ArrowRight,
  Wallet,
  TrendingUp,
} from "lucide-react";

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground leading-relaxed space-y-2">
        {children}
      </CardContent>
    </Card>
  );
}

export default function Docs() {
  usePageSEO({
    title: "Documentation - Blue Water Agents",
    description: "Technical documentation for the Blue Water Agents AI trading platform architecture, financial model, and developer goals",
  });

  return (
    <div className="p-3 md:p-6 space-y-4" data-testid="page-docs">
      <div>
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="text-docs-title">Documentation</h2>
        <p className="text-xs text-muted-foreground">Platform architecture, financial model, and developer vision</p>
      </div>

      <Tabs defaultValue="architecture">
        <TabsList className="flex-wrap" data-testid="tabs-docs">
          <TabsTrigger value="architecture" data-testid="tab-architecture">
            <Layers className="h-3.5 w-3.5 mr-1" />
            Architecture
          </TabsTrigger>
          <TabsTrigger value="financial" data-testid="tab-financial">
            <Coins className="h-3.5 w-3.5 mr-1" />
            Financial Model
          </TabsTrigger>
          <TabsTrigger value="developer" data-testid="tab-developer">
            <Code2 className="h-3.5 w-3.5 mr-1" />
            Developer Goals
          </TabsTrigger>
        </TabsList>

        <TabsContent value="architecture" className="mt-3 space-y-3">
          <Section icon={Layers} title="System Overview">
            <p>
              Blue Water Agents is a Web3 AI trading platform built on the SUI blockchain. It uses a
              dual-agent architecture where each deployed trading bot consists of two paired components:
              an Execution Agent and a Signal Sub-Agent working in tandem.
            </p>
            <p>
              The platform connects to real decentralized exchanges (DEXs) on SUI mainnet for
              perpetual contract trading. All transactions are verifiable on-chain via transaction
              digests recorded for every deposit, trade, and reward claim.
            </p>
          </Section>

          <Section icon={Bot} title="Dual-Agent Architecture">
            <p className="font-medium text-foreground">Execution Agent</p>
            <p>
              Manages the agent wallet (Ed25519 keypair), balance, orders, positions, and risk
              parameters. Handles on-chain trade execution through modular DEX adapters. Enforces
              stop-loss, take-profit, leverage limits, and position sizing rules.
            </p>
            <p className="font-medium text-foreground mt-2">Signal Sub-Agent</p>
            <p>
              Runs continuous indicator analysis using a 7-condition scoring system requiring
              4-of-7 agreement with minimum margin of 2. Evaluates RSI Zone ({'<'}40 long / {'>'}60 short),
              Connors RSI ({'<'}25 / {'>'}75), RSI Divergence, Price vs EMA(20), Trend Alignment
              (TEMA {'>'} DEMA {'>'} EMA), MACD Momentum (histogram + crossover), and 5-Bar Reversal
              (mean-reversion). Strong signals require 6+ conditions; weak requires 4+.
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="outline" className="text-[10px]">RSI Zone</Badge>
              <Badge variant="outline" className="text-[10px]">Connors RSI</Badge>
              <Badge variant="outline" className="text-[10px]">RSI Divergence</Badge>
              <Badge variant="outline" className="text-[10px]">Price vs EMA(20)</Badge>
              <Badge variant="outline" className="text-[10px]">Trend Alignment</Badge>
              <Badge variant="outline" className="text-[10px]">MACD Momentum</Badge>
              <Badge variant="outline" className="text-[10px]">5-Bar Reversal</Badge>
            </div>
          </Section>

          <Section icon={Globe} title="DEX Integration">
            <p>
              The platform uses a modular adapter pattern for DEX connectivity. Each adapter
              implements a common interface (DexAdapter) for opening/closing positions, estimating
              fees, and managing orders.
            </p>
            <p className="font-medium text-foreground mt-2">Supported Venues</p>
            <div className="space-y-1 mt-1">
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span><span className="font-medium text-foreground">Typus Perps</span> - On-chain perpetual trading on SUI with Pyth oracle pricing and up to 50x leverage</span>
              </div>
            </div>
          </Section>

          <Section icon={Shield} title="Security & Wallet Management">
            <p>
              Agent wallets use Ed25519 keypairs generated via the SUI SDK. Private keys are encrypted
              at rest using NaCl secretbox with a key derived from the server SESSION_SECRET. Encrypted
              keys are never exposed via API endpoints.
            </p>
            <p>
              All deposits require on-chain transaction verification. The platform checks transaction
              digests against SUI mainnet RPC, validates sender addresses, and confirms transfer
              amounts match before crediting agent balances.
            </p>
          </Section>

          <Section icon={Radio} title="Real-Time Data Pipeline">
            <p>
              Price data flows from the Pyth Oracle network (Hermes API) with 5-second polling
              intervals. The market engine maintains rolling price history for indicator calculations
              and broadcasts updates to connected clients via WebSocket.
            </p>
            <p>
              The signal engine runs on each price tick, evaluating all active agents' signal
              sub-agents and triggering the execution engine when actionable signals are generated.
            </p>
          </Section>

          <Section icon={Database} title="Data Model">
            <p>
              PostgreSQL database with Drizzle ORM. Core tables: users (wallet-based accounts),
              agents (execution agents), signal_agents (signal sub-agents), signals (trading signals),
              orders (trade orders with venue/txDigest), positions (open/closed with on-chain verification),
              rewards (trading rewards), protocol_fees (fee records), and verified_transactions
              (on-chain validated records).
            </p>
          </Section>
        </TabsContent>

        <TabsContent value="financial" className="mt-3 space-y-3">
          <Section icon={Coins} title="Protocol Fee Structure">
            <p>
              The Blue Water Protocol charges a <span className="font-bold text-foreground">2% fee</span> on
              all agent deposits. This fee is collected before the remaining balance is credited to
              the agent's trading account.
            </p>
            <div className="mt-2 p-3 rounded-md bg-muted/30 space-y-1">
              <div className="flex justify-between">
                <span>User deposits</span>
                <span className="font-mono text-foreground">10.0000 SUI</span>
              </div>
              <div className="flex justify-between text-chart-5">
                <span>Protocol fee (2%)</span>
                <span className="font-mono">-0.2000 SUI</span>
              </div>
              <div className="border-t pt-1 flex justify-between font-medium text-foreground">
                <span>Agent receives</span>
                <span className="font-mono">9.8000 SUI</span>
              </div>
            </div>
          </Section>

          <Section icon={Wallet} title="Protocol Wallet">
            <p>
              All protocol fees are sent to the Blue Water Digital protocol wallet:
            </p>
            <p className="font-mono text-[10px] text-foreground break-all mt-1 p-2 rounded-md bg-muted/30">
              0xf40709feb6dcdbfbc4f93eff4ddf50137ea6e1dc4f7a4167e7e260a8569613d6
            </p>
            <p className="mt-2">
              Deposit transactions include two SUI transfers: one to the agent's on-chain wallet
              and one to the protocol fee address. Both transfers are verified against the on-chain
              transaction data before the deposit is approved.
            </p>
          </Section>

          <Section icon={TrendingUp} title="Reward System">
            <p>
              Trading rewards are generated from agent trading activity. Rewards accrue to the user
              who owns the agent and can be claimed through wallet-signed transactions.
            </p>
            <p>
              The claim process requires the user to sign a transaction with their connected SUI
              wallet. The signed transaction digest is verified on SUI mainnet before the reward
              status is updated. Only rewards from active (running) agents can be claimed.
            </p>
          </Section>

          <Section icon={Zap} title="Execution Economics">
            <p>
              Trade execution follows the signal engine's recommendations. A 90% safety margin is
              applied to available balance before position sizing. maxQty means max collateral per
              trade (position size = collateral x leverage). A 120-second same-direction cooldown
              prevents duplicate trades. Up to 5 concurrent positions per agent with locked collateral
              tracking. Stop-loss and take-profit levels (in basis points) trigger automatic position closure.
            </p>
            <p>
              A circuit breaker pauses agents after 3 consecutive failures (60s cooldown, auto-recovery).
              Daily spend cap auto-pauses agents when failed gas exceeds 0.05 SUI or 10 failed transactions.
            </p>
          </Section>
        </TabsContent>

        <TabsContent value="developer" className="mt-3 space-y-3">
          <Section icon={Code2} title="Vision & Mission">
            <p>
              Blue Water Agents aims to democratize algorithmic trading on SUI by providing an
              accessible platform where users can deploy AI-powered trading agents without writing
              code. The dual-agent architecture separates signal intelligence from execution logic,
              enabling modular strategy development.
            </p>
          </Section>

          <Section icon={Layers} title="Technical Stack">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Frontend</Badge>
                <span>React + Vite + Tailwind CSS + shadcn/ui + Recharts</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Backend</Badge>
                <span>Express.js + PostgreSQL (Drizzle ORM) + WebSocket</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Web3</Badge>
                <span>@mysten/sui SDK + @mysten/dapp-kit + Pyth Oracle</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Analysis</Badge>
                <span>Custom indicator engine (RSI, Connors RSI, EMA, DEMA, TEMA)</span>
              </div>
            </div>
          </Section>

          <Section icon={Shield} title="Design Principles">
            <div className="space-y-2">
              <div>
                <p className="font-medium text-foreground">On-Chain Verifiability</p>
                <p>Every financial action generates an on-chain transaction digest. Deposits, trades, and
                reward claims are verifiable on SUI Explorer.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">No Mock Data</p>
                <p>The platform shows empty states until real agents are created and funded. All displayed
                data comes from actual user interactions and live market feeds.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Security First</p>
                <p>Agent private keys are encrypted at rest. Wallet addresses are sanitized from API
                responses. Transaction verification prevents spoofed deposits.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Modular DEX Integration</p>
                <p>The adapter pattern allows new DEX venues to be added without modifying core trading
                logic. Each adapter handles venue-specific transaction building and signing.</p>
              </div>
            </div>
          </Section>

          <Section icon={Globe} title="Roadmap & Future">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Multi-strategy support beyond momentum (mean reversion, breakout, grid)</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Additional DEX venue adapters as SUI DeFi ecosystem grows</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>SUI NS name integration for user identity and leaderboards</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Agent marketplace for sharing and cloning successful strategies</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Advanced risk analytics and portfolio management tools</span>
              </div>
            </div>
          </Section>

          <Card>
            <CardContent className="text-center py-6 space-y-1">
              <p className="text-xs font-mono text-muted-foreground">Developed by lifeguard.sui</p>
              <p className="text-xs font-mono text-muted-foreground">Powered by Blue Water Digital</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
