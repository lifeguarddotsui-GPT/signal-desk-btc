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
  Activity,
  AlertTriangle,
  Target,
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
          <TabsTrigger value="trading" data-testid="tab-trading">
            <Activity className="h-3.5 w-3.5 mr-1" />
            Trading Engine
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
              The platform connects to Typus Finance on SUI mainnet for SUI-USDC perpetual contract
              trading. All transactions are verifiable on-chain via transaction digests recorded for
              every deposit, trade, and reward claim.
            </p>
          </Section>

          <Section icon={Bot} title="Dual-Agent Architecture">
            <p className="font-medium text-foreground">Execution Agent</p>
            <p>
              Manages the agent wallet (Ed25519 keypair), balance, orders, positions, and risk
              parameters. Handles on-chain trade execution through the Typus DEX adapter. Enforces
              stop-loss, take-profit, leverage limits, and adaptive position sizing. Implements a
              strict position lifecycle state machine (pending_open, open, closed) with deterministic
              on-chain reconciliation.
            </p>
            <p className="font-medium text-foreground mt-2">Triton Signal Engine</p>
            <p>
              Regime-aware signal engine using multi-timeframe data (5m decision, 15m/1h confirmation).
              Detects TREND vs RANGE regimes via ADX. Supports three modes: AGGRESSIVE (wider thresholds,
              score 30+), PRECISION (tighter thresholds, score 48+), and AUTO (selects AGGRESSIVE when
              ADX {'>'} 18 and vol {'>'} 0.6, otherwise PRECISION).
            </p>
            <p className="mt-1">
              Scoring is based on weighted indicators: RSI zone, EMA distance/pullback, volume multiplier,
              ADX trend strength, HTF alignment, MACD momentum, VWAP distance, and RSI recovery entries.
              Position sizing is adaptive: 25-100% of max collateral based on signal score.
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="outline" className="text-[10px]">RSI Zone</Badge>
              <Badge variant="outline" className="text-[10px]">EMA Distance</Badge>
              <Badge variant="outline" className="text-[10px]">Volume</Badge>
              <Badge variant="outline" className="text-[10px]">ADX Trend</Badge>
              <Badge variant="outline" className="text-[10px]">HTF Alignment</Badge>
              <Badge variant="outline" className="text-[10px]">MACD</Badge>
              <Badge variant="outline" className="text-[10px]">VWAP</Badge>
              <Badge variant="outline" className="text-[10px]">RSI Recovery</Badge>
            </div>
          </Section>

          <Section icon={Globe} title="DEX Integration">
            <p>
              The platform uses a modular adapter pattern (DexAdapter interface) for DEX connectivity.
              Typus Perps is the primary venue, using keeper-based market orders with per-position
              gas caps, strict market order enforcement, and slippage control.
            </p>
            <p className="font-medium text-foreground mt-2">Typus Perps Features</p>
            <div className="space-y-1 mt-1">
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>On-chain perpetual trading on SUI mainnet with Pyth oracle pricing, up to 50x leverage</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Two-step position_id assignment (order_id on create, position_id after keeper fill)</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Idempotent close state machine with DB-persisted state tracking, retry logic, and terminal error detection</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                <span>Pre-close on-chain existence verification, dry-run preflights, and order_not_found terminal handling</span>
              </div>
            </div>
          </Section>

          <Section icon={Shield} title="Safety Systems">
            <p className="font-medium text-foreground">Anti-Liquidation Protection (3-Tier)</p>
            <div className="space-y-1 mt-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0">1.</span>
                <span>Stop-loss auto-tightening as unrealized loss grows</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0">2.</span>
                <span>Max collateral loss cap triggers emergency close</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-primary font-bold shrink-0">3.</span>
                <span>Emergency close with last-resort gas budget</span>
              </div>
            </div>
            <p className="font-medium text-foreground mt-2">Transaction Safety</p>
            <p>
              Per-wallet transaction queue, CoinManager for gas reserves, dry-run preflights before every trade,
              safe-execute with retry logic, three-layer order cleanup, and orphaned order recovery. Daily gas
              caps auto-pause agents. Circuit breaker pauses after consecutive failures with auto-recovery.
            </p>
            <p className="font-medium text-foreground mt-2">Close Error Classification</p>
            <p>
              Terminal errors (order_not_found, key_not_found, position_not_found) immediately stop retries
              and trigger on-chain position existence verification. If position is gone, it's classified as
              liquidated or settled based on LiquidateEvent detection and wallet balance analysis.
            </p>
          </Section>

          <Section icon={Radio} title="Real-Time Data Pipeline">
            <p>
              Price data flows from the Pyth Oracle network (Hermes API) with continuous polling.
              The market engine maintains rolling price history for multi-timeframe indicator
              calculations and broadcasts updates to connected clients via WebSocket.
            </p>
            <p>
              The signal engine runs on each price tick, evaluating all active agents' signal
              sub-agents. When actionable signals are generated, the execution engine handles
              position sizing, trade submission, and on-chain confirmation.
            </p>
          </Section>

          <Section icon={Database} title="Data Model">
            <p>
              PostgreSQL database with Drizzle ORM. Core tables: users, agents, signal_agents, signals,
              orders, positions (with close state machine fields), rewards, protocol_fees, deposits,
              verified_transactions, instruction_bundles, bundle_executions, typus_tracked_orders,
              close_outcomes (learning engine), and policy_weights (UCB bandit algorithm).
            </p>
            <p className="mt-1">
              Chain-derived stats computed from on-chain wallet transaction history provide ground-truth
              PnL, trade classification (win/loss/liquidated/cancelled), and SUI flow analysis independent
              of database records.
            </p>
          </Section>
        </TabsContent>

        <TabsContent value="trading" className="mt-3 space-y-3">
          <Section icon={Target} title="Signal Modes">
            <div className="space-y-2">
              <div className="p-2.5 bg-muted/30 rounded-md">
                <p className="font-medium text-foreground text-[11px]">AGGRESSIVE Mode</p>
                <p className="text-[10px]">Weak score: 30+ | Strong: 45+ | EMA distance: 4.0% max | Vol: 0.25x min | ADX trend: 14+ | Allows momentum continuation</p>
              </div>
              <div className="p-2.5 bg-muted/30 rounded-md">
                <p className="font-medium text-foreground text-[11px]">PRECISION Mode</p>
                <p className="text-[10px]">Weak score: 48+ | Strong: 60+ | EMA distance: 1.0% max | Vol: 0.60x min | ADX trend: 20+ | Requires MACD turn for weak signals</p>
              </div>
              <div className="p-2.5 bg-muted/30 rounded-md border border-primary/20">
                <p className="font-medium text-primary text-[11px]">AUTO Mode (Default)</p>
                <p className="text-[10px]">Dynamically selects AGGRESSIVE when ADX {'>'} 18 and vol {'>'} 0.6 (strong trend), otherwise falls back to PRECISION</p>
              </div>
            </div>
          </Section>

          <Section icon={Activity} title="Position Lifecycle">
            <p className="font-medium text-foreground">State Machine: pending_open {'>'} open {'>'} closed</p>
            <p>
              Positions start as pending_open when the create_trading_order TX is submitted. Background
              resolution polls on-chain to assign the position_id (Typus uses two-step assignment where
              order_id and position_id are different). Once resolved, positions become open with full
              on-chain position data.
            </p>
            <p className="font-medium text-foreground mt-2">Close State Machine</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              <Badge variant="outline" className="text-[10px]">open</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[10px]">close_requested</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[10px]">close_order_working</Badge>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="text-[10px]">closed</Badge>
            </div>
            <p className="mt-1">
              Terminal states: closed (normal), manual_review (order_not_found/key_not_found).
              Cooldowns prevent close spam: 30s between attempts, 90s pending close max age,
              45s close pending TTL.
            </p>
          </Section>

          <Section icon={AlertTriangle} title="Error Handling & Recovery">
            <div className="space-y-1.5">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">ORDER_NOT_FOUND</Badge>
                <span className="text-[10px]">Position/order no longer exists on Typus (liquidated or filled by keeper). Terminal: stops retries, verifies on-chain, settles as liquidated or closed.</span>
              </div>
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">KEY_NOT_FOUND</Badge>
                <span className="text-[10px]">Position ID mismatch (stored order_id vs actual position_id). Attempts re-resolution from on-chain fill events before retrying.</span>
              </div>
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">TOO_MANY_LINKED</Badge>
                <span className="text-[10px]">Existing unfilled orders block new close. Deep-cancels linked orders via wallet history scan, then retries.</span>
              </div>
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">ORACLE_MISMATCH</Badge>
                <span className="text-[10px]">Pyth price too stale or mismatched. 5-minute cooldown before retry.</span>
              </div>
            </div>
          </Section>

          <Section icon={TrendingUp} title="Learning Engine">
            <p>
              Tracks close outcomes in the close_outcomes table. Maintains policy_weights using
              EWMA-based reward scoring. Assigns scores based on success, failure, speed, and
              slippage. Updates weights using a UCB (Upper Confidence Bound) bandit algorithm
              for optimal close action selection across different market regimes.
            </p>
          </Section>

          <Section icon={Zap} title="Cooldowns & Rate Limits">
            <div className="grid grid-cols-2 gap-2 mt-1">
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Trade Cooldown</p>
                <p className="text-[10px] font-mono">10 seconds</p>
              </div>
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Loss Cooldown</p>
                <p className="text-[10px] font-mono">30 seconds</p>
              </div>
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Streak Loss (3+)</p>
                <p className="text-[10px] font-mono">3 minutes</p>
              </div>
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Skip Bundle</p>
                <p className="text-[10px] font-mono">5 minutes</p>
              </div>
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Close Cooldown</p>
                <p className="text-[10px] font-mono">30 seconds</p>
              </div>
              <div className="bg-muted/30 rounded-md p-2">
                <p className="text-[10px] font-medium text-foreground">Signal TTL</p>
                <p className="text-[10px] font-mono">45 seconds</p>
              </div>
            </div>
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
              All protocol fees are sent to the Blue Water Protocol LLC protocol wallet:
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
              Trading rewards are generated from profitable position closures. Rewards are escrowed
              on-chain and calculated based on reinvestedAmount and balance-confirmed settlements.
              The reward share percentage is configurable per agent (default 50%).
            </p>
            <p>
              The claim process requires the user to sign a transaction with their connected SUI
              wallet. The signed transaction digest is verified on SUI mainnet before the reward
              status is updated.
            </p>
          </Section>

          <Section icon={Zap} title="Execution Economics">
            <p>
              Adaptive position sizing: 25-100% of max collateral based on signal score (scores 30-39
              use 25-30%, scores 40-49 use 30-50%, scores 50+ use 50-100%). Min collateral is 0.2 SUI,
              configurable up to max collateral per agent. Position size = collateral x leverage.
            </p>
            <p className="mt-1">
              Gas management: two-tier gas policy with dynamic budgeting (10M-200M MIST), 0.03 SUI
              collateral gas reserve, 0.02 SUI per close estimate, 0.005 SUI absolute minimum.
              Max close gas per position capped at 0.15 SUI to prevent gas drain.
            </p>
            <p className="mt-1">
              Daily spend cap auto-pauses agents when failed gas exceeds 0.05 SUI or 10 failed
              transactions. Circuit breaker pauses after 3 consecutive failures (60s cooldown,
              auto-recovery).
            </p>
          </Section>

          <Section icon={Activity} title="Chain-Derived PnL">
            <p>
              Portfolio values and PnL are computed from on-chain wallet transaction history,
              providing ground-truth data independent of database records. The SUI Flow Tracker
              scans all wallet transactions, categorizes SUI movements (deposits, trade opens,
              close returns, cancel returns, gas), and detects liquidations via LiquidateEvent.
            </p>
            <p className="mt-1">
              The TX Inspector endpoint provides detailed breakdown of any Sui transaction digest
              including error classification (ORDER_NOT_FOUND, KEY_NOT_FOUND, SLIPPAGE, etc.),
              Move abort details, balance changes, and gas costs.
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
                <Badge variant="outline" className="text-[10px]">Trading</Badge>
                <span>Typus Perps adapter + Triton Signal Engine + Learning Engine</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Analysis</Badge>
                <span>RSI, Connors RSI, EMA/DEMA/TEMA, MACD, ADX, ATR, VWAP, Volume</span>
              </div>
            </div>
          </Section>

          <Section icon={Shield} title="Design Principles">
            <div className="space-y-2">
              <div>
                <p className="font-medium text-foreground">On-Chain Verifiability</p>
                <p>Every financial action generates an on-chain transaction digest. Deposits, trades, and
                reward claims are verifiable on SUI Explorer. Chain-derived stats provide ground-truth PnL.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Fail Explicitly, Not Silently</p>
                <p>Terminal errors (order_not_found, key_not_found) are detected and classified immediately.
                Positions are settled based on on-chain evidence, not assumptions. No silent fallbacks.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Gas-Conscious Execution</p>
                <p>Dry-run preflights before every trade. Pre-close on-chain existence checks before attempting
                close. Per-position gas caps prevent drain. Daily spend limits auto-pause agents.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Deterministic Reconciliation</p>
                <p>Position state is reconciled against on-chain truth. DB records auto-corrected when they
                diverge from chain-derived data (e.g., false liquidations corrected to cancelled).</p>
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
              <p className="text-xs font-mono text-muted-foreground">Powered by Blue Water Protocol LLC</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
