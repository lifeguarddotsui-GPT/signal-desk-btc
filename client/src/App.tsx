import { Component, type ReactNode, useState } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Link, useLocation } from "wouter";
import Dashboard from "@/pages/Dashboard";
import CryptoScanner from "@/pages/CryptoScanner";
import SportsScanner from "@/pages/SportsScanner";
import SignalDetail from "@/pages/SignalDetail";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/not-found";
import { LayoutDashboard, Cpu, Trophy, Bell, Settings2, Waves, Menu, X, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorBoundaryState { hasError: boolean; error: Error | null; }
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 max-w-md text-center">
            <p className="text-sm font-semibold text-red-400 mb-2">Something went wrong</p>
            <p className="text-xs text-muted-foreground mb-4">{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()}
              className="text-xs px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors">
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV_ITEMS = [
  { path: "/",        label: "Daily Picks",    icon: LayoutDashboard, badge: "SPORTS" },
  { path: "/sports",  label: "Sports & Fights",icon: Trophy,          badge: "NEW" },
  { path: "/crypto",  label: "Crypto 15m",     icon: Cpu,             badge: null },
  { path: "/alerts",  label: "Alerts",         icon: Bell,            badge: null },
  { path: "/settings",label: "Settings",       icon: Settings2,       badge: null },
];

function Sidebar({ mobile, onClose }: { mobile?: boolean; onClose?: () => void }) {
  const [location] = useLocation();

  return (
    <aside className={cn(
      "flex flex-col h-full bg-sidebar border-r border-sidebar-border",
      mobile ? "w-72" : "w-64 hidden lg:flex"
    )}>
      {/* Logo */}
      <div className="px-5 pt-6 pb-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#0052FF] flex items-center justify-center shadow-lg">
            <Waves className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <p className="text-[13px] font-bold text-white leading-tight">Blue Water</p>
            <p className="text-[10px] font-semibold text-[#0052FF] uppercase tracking-widest leading-tight">Predictions</p>
          </div>
        </div>
        {mobile && (
          <button onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-white">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ path, label, icon: Icon, badge }) => {
          const active = path === "/" ? location === "/" : location.startsWith(path);
          return (
            <Link key={path} href={path} onClick={onClose} className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group",
                active
                  ? "bg-[#0052FF] text-white shadow-md"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
              )}>
                <Icon className={cn("w-4 h-4 shrink-0", active ? "text-white" : "text-muted-foreground group-hover:text-white")} />
                <span className="flex-1">{label}</span>
                {badge && (
                  <span className={cn(
                    "text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest",
                    active ? "bg-white/20 text-white" : "bg-[#0052FF]/20 text-[#4D8FFF]"
                  )}>{badge}</span>
                )}
                {active && <ChevronRight className="w-3 h-3 text-white/60" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-sidebar-border">
        <div className="rounded-lg bg-[#0052FF]/10 border border-[#0052FF]/20 p-3">
          <p className="text-[10px] font-semibold text-[#4D8FFF] uppercase tracking-wider mb-1">⚠ Research Only</p>
          <p className="text-[10px] text-muted-foreground leading-tight">
            Prediction markets involve risk. Contracts may expire worthless. This app provides research only, not financial advice.
          </p>
        </div>
        <p className="text-[9px] text-muted-foreground/50 text-center mt-3">
          Powered by Coinbase Prediction Markets
        </p>
      </div>
    </aside>
  );
}

function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="relative">
            <Sidebar mobile onClose={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile topbar */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-sidebar">
          <button onClick={() => setMobileOpen(true)} className="text-muted-foreground hover:text-white">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-[#0052FF] flex items-center justify-center">
              <Waves className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-white">Blue Water Predictions</span>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/crypto" component={CryptoScanner} />
              <Route path="/sports" component={SportsScanner} />
              <Route path="/alerts" component={AlertsPage} />
              <Route path="/signal/:id" component={SignalDetail} />
              <Route path="/settings" component={Settings} />
              <Route component={NotFound} />
            </Switch>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function AlertsPage() {
  const { useQuery } = require("@tanstack/react-query");
  const { data: alerts = [] } = useQuery({ queryKey: ["/api/alerts"], refetchInterval: 10000 });
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-xl font-bold text-white mb-6">Recent Alerts</h1>
      {(alerts as any[]).length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">No alerts yet. High-confidence picks trigger automatic alerts.</div>
      ) : (
        <div className="space-y-3">
          {(alerts as any[]).map((a: any) => (
            <div key={a.id} className="flex items-start gap-3 p-4 rounded-xl border border-border bg-card">
              <div className={cn("w-2 h-2 rounded-full mt-1.5 shrink-0",
                a.alertType === "high_confidence" ? "bg-emerald-400" :
                a.alertType === "daily_report" ? "bg-[#0052FF]" : "bg-yellow-400"
              )} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white leading-snug">{a.message}</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {new Date(a.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                {a.alertType?.replace("_", " ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppShell />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
