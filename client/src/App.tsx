import { Switch, Route } from "wouter";
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
import MarketDashboard from "@/pages/market-dashboard";
import DeployAgent from "@/pages/deploy-agent";
import ClaimRewards from "@/pages/claim-rewards";
import NotFound from "@/pages/not-found";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useLivePrice } from "@/lib/ws-context";

const { networkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

function LivePriceIndicator() {
  const lastPrice = useLivePrice();
  if (!lastPrice) return null;

  return (
    <Badge variant="outline" className="font-mono text-xs gap-1.5" data-testid="badge-live-price">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      SUI ${lastPrice.blended?.toFixed(4) || "--"}
      {lastPrice.pyth && (
        <span className="text-muted-foreground ml-1">Pyth</span>
      )}
    </Badge>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={MarketDashboard} />
      <Route path="/deploy" component={DeployAgent} />
      <Route path="/rewards" component={ClaimRewards} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-2 p-2 border-b sticky top-0 z-50 bg-background">
            <div className="flex items-center gap-2">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <LivePriceIndicator />
            </div>
            <div className="flex items-center gap-2">
              <ConnectButton data-testid="button-connect-wallet" />
              <ThemeToggle />
            </div>
          </header>
          <ScrollArea className="flex-1">
            <main>
              <Router />
            </main>
          </ScrollArea>
        </div>
      </div>
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
                <AppContent />
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
