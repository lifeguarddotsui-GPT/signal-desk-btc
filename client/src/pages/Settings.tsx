import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Settings2, DollarSign, Bell, Shield, CheckCircle, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const RISK_RULES = [
  { range: "9 – 10", action: "Strong Buy", bet: "Max 3% bankroll", color: "text-emerald-400 bg-emerald-400/10" },
  { range: "8 – 8.9", action: "Buy", bet: "Max 2% bankroll", color: "text-blue-400 bg-blue-400/10" },
  { range: "7 – 7.9", action: "Watch", bet: "Max 1% bankroll", color: "text-yellow-400 bg-yellow-400/10" },
  { range: "6.5 – 6.9", action: "Watchlist", bet: "No bet recommended", color: "text-orange-400 bg-orange-400/10" },
  { range: "< 6.5", action: "Avoid", bet: "Do not bet", color: "text-red-400 bg-red-400/10" },
];

export default function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["/api/settings"],
  });

  const [bankroll, setBankroll] = useState("");
  const [emailNotifs, setEmailNotifs] = useState(false);
  const [minConfidence, setMinConfidence] = useState("8.0");

  useEffect(() => {
    if (settings) {
      const s = settings as any;
      setBankroll(s.bankrollAmount?.toString() ?? "1000");
      setEmailNotifs(s.emailNotifications ?? false);
      setMinConfidence(s.minConfidenceAlert?.toString() ?? "8.0");
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: () => apiRequest("POST", "/api/settings", {
      bankrollAmount: parseFloat(bankroll) || 1000,
      emailNotifications: emailNotifs,
      minConfidenceAlert: parseFloat(minConfidence) || 8.0,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved", description: "Your preferences have been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
    },
  });

  const testAlert = useMutation({
    mutationFn: () => apiRequest("POST", "/api/alerts/test"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Test alert sent", description: "Check the Alerts tab." });
    },
  });

  const bankrollNum = parseFloat(bankroll) || 1000;
  const betSizes = [
    { score: "9+", pct: 3, amount: (bankrollNum * 0.03).toFixed(2) },
    { score: "8+", pct: 2, amount: (bankrollNum * 0.02).toFixed(2) },
    { score: "7+", pct: 1, amount: (bankrollNum * 0.01).toFixed(2) },
  ];

  return (
    <div className="min-h-full">
      {/* Hero */}
      <div className="halftone-bg bg-[#0052FF] px-6 py-7 md:px-10">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <Settings2 className="w-4 h-4 text-blue-200" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-blue-200 font-bold">Settings</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-black text-white mb-1">Preferences</h1>
          <p className="text-blue-200 text-sm">Configure your bankroll and notification thresholds</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-5">
        {/* Bankroll */}
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="w-4 h-4 text-[#4D8FFF]" />
            <h2 className="text-sm font-bold text-white">Bankroll</h2>
          </div>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block" htmlFor="bankroll">
                Total bankroll amount (USD)
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="bankroll"
                  type="number"
                  min="1"
                  step="50"
                  value={bankroll}
                  onChange={e => setBankroll(e.target.value)}
                  className="pl-7 font-mono"
                  data-testid="input-bankroll"
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Used to calculate suggested max bet sizes on each signal.
              </p>
            </div>
          </div>

          {/* Bet size preview */}
          <div className="mt-4 p-4 rounded-lg bg-muted/30 border border-border">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Bet Sizes Preview</p>
            <div className="space-y-2">
              {betSizes.map(({ score, pct, amount }) => (
                <div key={score} className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Score {score} ({pct}% max)</span>
                  <span className="text-xs font-bold text-white font-mono">${amount}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Risk Rules */}
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-4 h-4 text-[#4D8FFF]" />
            <h2 className="text-sm font-bold text-white">Risk Management Rules</h2>
          </div>
          <div className="space-y-2">
            {RISK_RULES.map(({ range, action, bet, color }) => (
              <div key={range} className={cn("flex items-center justify-between p-3 rounded-lg", color)}>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs font-black w-14">{range}</span>
                  <span className="text-sm font-bold">{action}</span>
                </div>
                <span className="text-[11px] opacity-80">{bet}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Notifications */}
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="w-4 h-4 text-[#4D8FFF]" />
            <h2 className="text-sm font-bold text-white">Notifications</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm text-white">In-app alerts</Label>
                <p className="text-[10px] text-muted-foreground">Always enabled — visible in the Alerts tab</p>
              </div>
              <div className="w-8 h-4 bg-[#0052FF] rounded-full flex items-center justify-end px-0.5">
                <div className="w-3 h-3 bg-white rounded-full" />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm text-white" htmlFor="email-notifs">Email notifications</Label>
                <p className="text-[10px] text-muted-foreground">Requires email setup in deployment</p>
              </div>
              <Switch
                id="email-notifs"
                checked={emailNotifs}
                onCheckedChange={setEmailNotifs}
                data-testid="switch-email-notifications"
              />
            </div>

            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block" htmlFor="min-confidence">
                Minimum confidence to alert ({minConfidence}/10)
              </Label>
              <Input
                id="min-confidence"
                type="number"
                min="5"
                max="10"
                step="0.5"
                value={minConfidence}
                onChange={e => setMinConfidence(e.target.value)}
                className="font-mono w-28"
                data-testid="input-min-confidence"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Signals above this score trigger notifications</p>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => testAlert.mutate()}
              disabled={testAlert.isPending}
              data-testid="button-test-alert"
              className="text-xs gap-1.5"
            >
              <Bell className="w-3.5 h-3.5" />
              {testAlert.isPending ? "Sending..." : "Send Test Alert"}
            </Button>
          </div>
        </div>

        {/* Data sources */}
        <div className="p-5 rounded-xl border border-border bg-card">
          <h2 className="text-sm font-bold text-white mb-4">Data Sources</h2>
          <div className="space-y-3">
            {[
              { name: "Coinbase Prediction Markets", url: "coinbase.com/predictions", status: "Mock (Swap-Ready)", statusColor: "text-yellow-400" },
              { name: "Crypto Prices", url: "CoinGecko API (free)", status: "Live", statusColor: "text-emerald-400" },
              { name: "Sports Odds", url: "Curated Research Data", status: "Mock (Swap-Ready)", statusColor: "text-yellow-400" },
            ].map(({ name, url, status, statusColor }) => (
              <div key={name} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <p className="text-xs font-semibold text-white">{name}</p>
                  <p className="text-[10px] text-muted-foreground">{url}</p>
                </div>
                <span className={cn("text-[10px] font-bold uppercase", statusColor)}>{status}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Save button */}
        <Button
          className="w-full gap-2 bg-[#0052FF] hover:bg-[#0041CC] text-white font-bold"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          data-testid="button-save-settings"
        >
          <CheckCircle className="w-4 h-4" />
          {save.isPending ? "Saving..." : "Save Settings"}
        </Button>

        {/* Disclaimer */}
        <div className="p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-[10px] text-yellow-200/60 leading-relaxed">
              <strong className="text-yellow-300">Research only — not financial advice.</strong> Coinbase prediction contracts involve substantial risk of loss. The max bet sizes shown are research guidelines only, not investment recommendations. Never bet more than you can afford to lose.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
