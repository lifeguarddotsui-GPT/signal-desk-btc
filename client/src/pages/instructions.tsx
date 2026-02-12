import { Card, CardContent } from "@/components/ui/card";
import { usePageSEO } from "@/lib/seo";
import {
  Wallet,
  BarChart3,
  Bot,
  Coins,
  Radio,
  Gift,
} from "lucide-react";

const steps = [
  {
    step: 1,
    icon: Wallet,
    title: "Connect SUI Wallet",
    description: "Connect your SUI-compatible wallet using the Connect button in the header. Your wallet address will be used to track agents, deposits, and rewards.",
  },
  {
    step: 2,
    icon: BarChart3,
    title: "Monitor Market Dashboard",
    description: "View live SUI-PERP prices from Pyth Oracle feeds. Track RSI, Connors RSI, MACD, EMA, DEMA, and TEMA indicators in real-time with candlestick charts.",
  },
  {
    step: 3,
    icon: Bot,
    title: "Deploy an Agent",
    description: "Choose a trading venue (Typus Finance, Astros Perps), set your leverage (1-25x), stop-loss, take-profit levels, and max position size. Each execution agent is automatically paired with a signal sub-agent.",
  },
  {
    step: 4,
    icon: Coins,
    title: "Fund Your Agent",
    description: "Deposit SUI into your agent's dedicated wallet. A 2% protocol fee is applied to each deposit. Provide a transaction digest for on-chain verification of your deposit.",
  },
  {
    step: 5,
    icon: Radio,
    title: "Monitor Signals",
    description: "The dual-agent architecture generates trading signals using a momentum strategy. Signal agents evaluate 5 indicators and require a 3-of-6 threshold to trigger. View signal history and scores on the dashboard.",
  },
  {
    step: 6,
    icon: Gift,
    title: "Claim Rewards",
    description: "Rewards are generated from profitable trades by your active agents. Claim pending rewards individually or all at once. Provide a transaction digest for on-chain verification of claims.",
  },
];

export default function Instructions() {
  usePageSEO({
    title: "Instructions",
    description: "Step-by-step guide on how to use Blue Water Agents for SUI-PERP trading with AI-powered signal generation.",
  });

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="page-instructions">
      <div className="space-y-1">
        <h2 className="text-lg md:text-xl font-bold tracking-tight" data-testid="instructions-heading">
          How to Use Blue Water Agents
        </h2>
        <p className="text-xs text-muted-foreground">
          Follow these steps to deploy and manage your AI trading agents on SUI-PERP.
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
