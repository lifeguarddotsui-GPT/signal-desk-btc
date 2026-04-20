import { Component, type ReactNode } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { WSProvider, useLivePrice } from "@/lib/ws-context";
import { SuiClientProvider, WalletProvider, ConnectButton, createNetworkConfig } from "@mysten/dapp-kit";
import { Badge } from "@/components/ui/badge";
import Dashboard from "@/pages/dashboard";

const { networkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}] Caught render error:`, error, info.componentStack);
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
                this.setState({ hasError: false, error: null });
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
  const price = lastPrice.price ?? lastPrice.blended;
  if (!price) return null;
  return (
    <Badge variant="outline" className="font-mono text-[10px] gap-1" data-testid="badge-live-price">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      SUI ${price.toFixed(4)}
    </Badge>
  );
}

function AppContent() {
  return (
    <div className="flex flex-col h-screen w-full">
      <header className="flex items-center justify-between gap-2 px-4 py-2 border-b sticky top-0 z-[100] bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-tight text-primary">Blue Water Agents</span>
          <ErrorBoundary label="LivePrice">
            <LivePriceIndicator />
          </ErrorBoundary>
        </div>
        <div className="flex items-center gap-2">
          <ConnectButton data-testid="button-connect-wallet" />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <ErrorBoundary label="Dashboard">
          <Dashboard />
        </ErrorBoundary>
      </div>
    </div>
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
