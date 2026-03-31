import { Switch, Route } from "wouter";
import { Component, type ReactNode } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { WSProvider } from "@/lib/ws-context";
import { SuiClientProvider, WalletProvider, ConnectButton, createNetworkConfig } from "@mysten/dapp-kit";
import Landing from "@/pages/landing";
import MarketDashboard from "@/pages/market-dashboard";
import DeployAgent from "@/pages/deploy-agent";
import MyAgents from "@/pages/my-agents";
import ClaimRewards from "@/pages/claim-rewards";
import Leaderboard from "@/pages/leaderboard";
import Protocol from "@/pages/protocol";
import Docs from "@/pages/docs";
import Learn from "@/pages/learn";
import Instructions from "@/pages/instructions";
import Profile from "@/pages/profile";
import Bundles from "@/pages/bundles";
import DebugLedger from "@/pages/debug-ledger";
import SuiFlow from "@/pages/sui-flow";
import SystemGuide from "@/pages/system-guide";
import OpenCode from "@/pages/open-code";
import About from "@/pages/about";
import MarketIntel from "@/pages/market-intel";
import NotFound from "@/pages/not-found";
import { Badge } from "@/components/ui/badge";
import { useLivePrice } from "@/lib/ws-context";
import { WalletBalance } from "@/components/wallet-balance";
import { MobileBottomNav } from "@/components/mobile-nav";

const { networkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}

class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, errorInfo: "" };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}] Caught render error:`, error, info.componentStack);
    this.setState({ errorInfo: info.componentStack?.slice(0, 300) || "" });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-6 text-center">
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 max-w-lg w-full">
            <p className="text-sm font-semibold text-red-400 mb-1">Something went wrong</p>
            <p className="text-[11px] text-muted-foreground mb-3">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null, errorInfo: "" });
                window.location.reload();
              }}
              className="text-[11px] px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function LivePriceIndicator() {
  const lastPrice = useLivePrice();
  if (!lastPrice) return null;

  return (
    <Badge variant="outline" className="font-mono text-[10px] gap-1" data-testid="badge-live-price">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      SUI ${lastPrice.blended?.toFixed(4) || "--"}
    </Badge>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/dashboard" component={MarketDashboard} />
      <Route path="/deploy" component={DeployAgent} />
      <Route path="/my-agents" component={MyAgents} />
      <Route path="/rewards" component={ClaimRewards} />
      <Route path="/leaderboard" component={Leaderboard} />
      <Route path="/protocol" component={Protocol} />
      <Route path="/docs" component={Docs} />
      <Route path="/learn" component={Learn} />
      <Route path="/instructions" component={Instructions} />
      <Route path="/profile" component={Profile} />
      <Route path="/bundles" component={Bundles} />
      <Route path="/debug/ledger" component={DebugLedger} />
      <Route path="/sui-flow" component={SuiFlow} />
      <Route path="/guide" component={SystemGuide} />
      <Route path="/open-code" component={OpenCode} />
      <Route path="/about" component={About} />
      <Route path="/market-intel" component={MarketIntel} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent() {
  const style = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-1 px-2 py-0.5 border-b sticky top-0 z-[100] bg-background/95 backdrop-blur-sm min-h-[2.25rem]">
            <div className="flex items-center gap-1 shrink-0">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <ErrorBoundary label="LivePrice">
                <LivePriceIndicator />
              </ErrorBoundary>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <ErrorBoundary label="WalletBalance">
                <WalletBalance />
              </ErrorBoundary>
              <div className="connect-btn-compact">
                <ConnectButton data-testid="button-connect-wallet" />
              </div>
              <ThemeToggle />
            </div>
          </header>
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <main className="pb-16 md:pb-0">
              <ErrorBoundary label="Router">
                <Router />
              </ErrorBoundary>
            </main>
          </div>
        </div>
      </div>
      <ErrorBoundary label="MobileNav">
        <MobileBottomNav />
      </ErrorBoundary>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <SuiClientProvider networks={networkConfig} defaultNetwork="mainnet">
          <WalletProvider autoConnect>
            <TooltipProvider>
              <WSProvider>
                <ErrorBoundary label="AppContent">
                  <AppContent />
                </ErrorBoundary>
              </WSProvider>
              <Toaster />
            </TooltipProvider>
          </WalletProvider>
        </SuiClientProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
