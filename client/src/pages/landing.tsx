import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePageSEO } from "@/lib/seo";
import {
  Activity,
  BarChart3,
  Shield,
  Zap,
  ArrowRight,
  Radio,
  Bot,
} from "lucide-react";

const features = [
  {
    icon: Radio,
    title: "Market Intelligence",
    description: "Real-time Pyth Oracle data with blended price feeds for accurate SUI-PERP market analysis.",
  },
  {
    icon: Bot,
    title: "Dual-Agent Architecture",
    description: "Execution agents paired with signal sub-agents for autonomous momentum-based trading.",
  },
  {
    icon: Shield,
    title: "On-Chain Verification",
    description: "Every trade and reward verified on the SUI blockchain with transaction digest tracking.",
  },
  {
    icon: Zap,
    title: "Automated Trading",
    description: "Momentum strategy signals using RSI, Connors RSI, EMA, DEMA, and TEMA indicators.",
  },
];

export default function Landing() {
  usePageSEO({
    title: "Blue Water Agents",
    description: "AI-powered trading agents for SUI-PERP perpetual markets. Dual-agent architecture with on-chain verification powered by Blue Water Digital.",
  });

  return (
    <div className="min-h-screen" data-testid="page-landing">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/60 to-background z-0" />
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/5 z-0" />

        <div className="relative z-10 flex flex-col items-center justify-center text-center px-4 py-24 md:py-36">
          <div className="flex items-center gap-3 mb-6" data-testid="hero-logo">
            <div className="w-12 h-12 rounded-md bg-primary flex items-center justify-center">
              <Activity className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>

          <h1
            className="text-3xl md:text-5xl font-bold tracking-tight text-white mb-4"
            data-testid="hero-title"
          >
            Blue Water Agents
          </h1>

          <p
            className="text-base md:text-lg text-white/70 max-w-xl mb-2"
            data-testid="hero-subtitle"
          >
            AI-powered trading agents for SUI-PERP perpetual markets with real-time signal generation and on-chain verification.
          </p>

          <p
            className="text-xs text-white/50 font-mono mb-8"
            data-testid="hero-credits"
          >
            Developed by lifeguard.sui | Powered by Blue Water Digital
          </p>

          <Link href="/dashboard">
            <Button size="lg" data-testid="button-launch-app">
              Launch App
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
        </div>
      </div>

      <div className="px-4 md:px-8 py-12 md:py-16 max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <h2 className="text-xl md:text-2xl font-bold tracking-tight mb-2" data-testid="features-heading">
            Built for Autonomous Trading
          </h2>
          <p className="text-sm text-muted-foreground">
            Everything you need to deploy and manage AI trading agents on the SUI network.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {features.map((feature, i) => (
            <Card key={feature.title} data-testid={`feature-card-${i}`}>
              <CardContent className="pt-6 pb-5 flex gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/15 flex items-center justify-center shrink-0">
                  <feature.icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold mb-1" data-testid={`feature-title-${i}`}>
                    {feature.title}
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="text-center mt-12">
          <div className="flex items-center justify-center gap-2 mb-4">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-mono">SUI-PERP | Momentum Strategy</span>
          </div>
          <Link href="/dashboard">
            <Button variant="outline" data-testid="button-launch-app-footer">
              Get Started
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
