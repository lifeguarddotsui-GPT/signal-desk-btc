import { Card, CardContent } from "@/components/ui/card";
import { usePageSEO } from "@/lib/seo";
import {
  Wallet,
  BarChart3,
  Bot,
  Coins,
  Radio,
  Gift,
  Zap,
  ArrowDownToLine,
  Copy,
  Activity,
} from "lucide-react";

const steps = [
  {
    step: 1,
    icon: Wallet,
    title: "Connect SUI Wallet",
    description: "Connect your SUI-compatible wallet using the Connect button in the header. Your wallet address will be used to track agents, deposits, and rewards. Supported wallets include Sui Wallet, Suiet, and other @mysten/dapp-kit compatible wallets.",
  },
  {
    step: 2,
    icon: BarChart3,
    title: "Monitor Market Dashboard",
    description: "View live SUI-USDC prices from Pyth Oracle feeds. Track RSI, EMA, MACD, ADX, ATR, and VWAP indicators in real-time with candlestick charts. Multi-timeframe data (5m, 15m, 1h) is used for signal generation. The dashboard shows current regime detection (TREND vs RANGE).",
  },
  {
    step: 3,
    icon: Bot,
    title: "Deploy an Agent",
    description: "Choose Typus Perps as your trading venue. Set leverage (1-50x), stop-loss (basis points), take-profit, and min/max collateral (0.2 SUI minimum). Select a signal mode: AGGRESSIVE (more trades, score 30+), PRECISION (fewer, higher-quality trades, score 48+), or AUTO (dynamically switches based on market conditions). Each agent is paired with a signal sub-agent automatically.",
  },
  {
    step: 4,
    icon: Coins,
    title: "Fund Your Agent",
    description: "Deposit SUI into your agent's dedicated wallet. A 2% protocol fee is applied to each deposit. Send SUI to the agent's wallet address displayed on the My Agents page, then provide the transaction digest for on-chain verification.",
  },
  {
    step: 5,
    icon: Zap,
    title: "Start Trading",
    description: "All agents operate in auto-trade mode. Once funded and started, the agent autonomously trades when signal conditions are met. The Triton Signal Engine evaluates regime, weighted indicator scores, and risk parameters on every price tick. Adaptive position sizing adjusts collateral (25-100%) based on signal strength.",
  },
  {
    step: 6,
    icon: Radio,
    title: "Monitor Signals & Positions",
    description: "Track open positions with live PnL, entry/mark prices, leverage, and on-chain verification on the My Agents page. Stop-loss and take-profit execute automatically. The signal sub-agent shows current reasoning, regime, score breakdown, and mode selection. View detailed chain-derived stats via the SUI Flow page.",
  },
  {
    step: 7,
    icon: Copy,
    title: "Clone Successful Agents",
    description: "Found a strategy that works? Clone any agent to create a copy with the same configuration (leverage, collateral, stop-loss, signal mode). The clone gets its own fresh wallet and trading history. Experiment with different settings by cloning and adjusting.",
  },
  {
    step: 8,
    icon: Activity,
    title: "Analyze Performance",
    description: "Use the SUI Flow page to see a complete forensic breakdown of every SUI movement in your agent's wallet: deposits in, trade opens, close returns, cancel returns, liquidations, and gas costs. All PnL is chain-derived from actual on-chain data for accuracy.",
  },
  {
    step: 9,
    icon: Gift,
    title: "Earn Rewards",
    description: "Rewards are automatically generated when positions close with a profit. Reward amounts are based on the configured reward share percentage (default 50%). Visit Claim Rewards to claim them individually or all at once via wallet-signed transactions.",
  },
  {
    step: 10,
    icon: ArrowDownToLine,
    title: "Withdraw Funds",
    description: "Pull your SUI balance from an agent's wallet back to your connected wallet at any time. Go to My Agents, select your agent, and click 'Withdraw to Wallet'. The agent signs an on-chain transfer directly to your wallet address.",
  },
];

export default function Instructions() {
  usePageSEO({
    title: "Instructions - Blue Water Agents",
    description: "Step-by-step guide on how to use Blue Water Agents for AI-powered SUI-USDC perpetual trading with regime-aware signal generation.",
  });

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="page-instructions">
      <div className="space-y-1">
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="instructions-heading">
          How to Use Blue Water Agents
        </h2>
        <p className="text-xs text-muted-foreground">
          Follow these steps to deploy and manage your AI trading agents on SUI-USDC.
        </p>
      </div>

      <div className="space-y-3">
        {steps.map((s) => (
          <Card key={s.step} data-testid={`instruction-step-${s.step}`}>
            <CardContent className="pt-5 pb-4 flex gap-4">
              <div className="flex flex-col items-center gap-2 shrink-0">
                <div className="w-10 h-10 rounded-md bg-primary/15 flex items-center justify-center">
                  <s.icon className="h-5 w-5 text-primary" />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  Step {s.step}
                </span>
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold mb-1" data-testid={`instruction-title-${s.step}`}>
                  {s.title}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {s.description}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
