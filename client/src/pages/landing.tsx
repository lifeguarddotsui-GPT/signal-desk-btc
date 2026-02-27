import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { usePageSEO } from "@/lib/seo";
import logoPath from "@/assets/images/logo.png";
import { ArrowRight } from "lucide-react";

export default function Landing() {
  usePageSEO({
    title: "Blue Water Agents",
    description: "AI-powered trading agents for SUI-USDC perpetual markets. Dual-agent architecture with on-chain verification powered by Blue Water Digital.",
  });

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" data-testid="page-landing">
      <div className="absolute inset-0 bg-gradient-to-b from-black via-background to-background z-0" />

      <div className="relative z-10 flex flex-col items-center text-center max-w-md mx-auto">
        <div className="mb-10" data-testid="hero-logo">
          <img
            src={logoPath}
            alt="Blue Water Agents"
            className="w-28 h-28 rounded-2xl object-cover opacity-90"
          />
        </div>

        <h1
          className="text-2xl md:text-4xl font-semibold tracking-tight text-foreground mb-3"
          data-testid="hero-title"
        >
          Blue Water Agents
        </h1>

        <p
          className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-xs"
          data-testid="hero-subtitle"
        >
          AI-powered trading agents for SUI-USDC perpetual markets with real-time signal generation and on-chain verification.
        </p>

        <p
          className="text-[11px] text-muted-foreground font-mono mb-10"
          data-testid="hero-credits"
        >
          lifeguard.sui | Blue Water Digital
        </p>

        <Link href="/dashboard">
          <Button size="lg" className="px-8" data-testid="button-launch-app">
            Launch App
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
