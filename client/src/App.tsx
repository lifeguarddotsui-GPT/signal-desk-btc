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
import NotFound from "@/pages/not-found";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useLivePrice } from "@/lib/ws-context";
import { WalletBalance } from "@/components/wallet-balance";
import { MobileBottomNav } from "@/components/mobile-nav";

const { networkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

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
              <LivePriceIndicator />
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <WalletBalance />
              <div className="connect-btn-compact">
                <ConnectButton data-testid="button-connect-wallet" />
              </div>
              <ThemeToggle />
            </div>
          </header>
          <ScrollArea className="flex-1">
            <main className="pb-16 md:pb-0">
              <Router />
            </main>
          </ScrollArea>
        </div>
      </div>
      <MobileBottomNav />
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
