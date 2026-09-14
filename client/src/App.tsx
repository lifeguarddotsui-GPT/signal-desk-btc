import { Component, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import { Bell, ChevronRight, Moon, Settings2, Sun } from "lucide-react";
import { queryClient } from "./lib/queryClient";
import { useEffect, useState } from "react";

type Signal = {
  id: string; asset: "SUI" | "DEEP"; type: string; direction: "LONG" | "SHORT";
  entryLow: number; entryHigh: number; preferredEntry: number; currentPrice: number;
  target1: number; target2: number; invalidation: number; probability: number | null;
  status: string; rrToT1: number; convergence: number; convergenceDirection: string;
  marketDirection: string; fundingContext: string;
  timeframe: { fourHour: string; oneHour: string; fifteenMinute: string };
  smsEligible: false; smsReason: string;
};
type Asset = {
  asset: "SUI" | "DEEP"; name: string; price: number; change24h: number; marketDirection: string;
  convergence: number; convergenceDirection: string; fundingContext: string; updatedAt: string;
  dataHealth: string; signals: Signal[];
  dataHealthReason: string;
  sourceHealth: { cexPrice: string; cexDerivatives: string; suiNativeSpot: string };
  nativeMarket: { venue: string; pair: string; lastPrice: number | null; spreadBps: number | null; volume24h: number | null; updatedAt: string | null };
  derivatives: { venue: string; instrument: string | null; fundingRate: number | null; openInterestUsd: number | null; updatedAt: string | null };
};
type Overview = { assets: Asset[]; bestOpportunity: Signal | null; updatedAt: string; modelStatus: string };

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error
      ? <main className="empty"><h1>Unable to load signals.</h1><button onClick={() => location.reload()}>Try again</button></main>
      : this.props.children;
  }
}

const nav = [["/", "Home"], ["/sui", "SUI"], ["/deep", "DEEP"], ["/performance", "Performance"], ["/alerts", "Alerts"], ["/account", "Account"]];
const money = (value: number, asset: string) => `$${value.toLocaleString(undefined, { minimumFractionDigits: asset === "DEEP" ? 4 : 3, maximumFractionDigits: asset === "DEEP" ? 5 : 4 })}`;

function Mark({ asset }: { asset?: string }) {
  return <span className={`mark ${asset?.toLowerCase() || ""}`}>{asset === "DEEP" ? "D" : asset === "SUI" ? "S" : "SD"}</span>;
}

function ThemeButton() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</button>;
}

function Layout({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  return <div className="app">
    <header>
      <Link href="/" className="brand"><Mark /><span>SUI + DEEP <b>SIGNALS</b></span></Link>
      <nav>{nav.map(([href, label]) => <Link key={href} href={href} className={path === href ? "active" : ""}>{label}</Link>)}</nav>
      <ThemeButton />
    </header>
    {children}
    <nav className="mobile-nav">{nav.slice(0, 5).map(([href, label]) => <Link key={href} href={href} className={path === href ? "active" : ""}>{label}</Link>)}</nav>
  </div>;
}

function useOverview() {
  return useQuery<Overview>({ queryKey: ["/api/sui-deep/overview"], refetchInterval: 30_000 });
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value.toLowerCase().replaceAll(" ", "-")}`}>{value}</span>;
}

function Opportunity({ signal }: { signal: Signal }) {
  return <Link href={`/signal/${signal.id}`} className="opportunity">
    <div className="opportunity-head">
      <div><p className="eyebrow">Best opportunity</p><div className="asset-title"><Mark asset={signal.asset} /><h1>{signal.asset}</h1><Status value={signal.type} /></div></div>
      <div className="probability"><strong>{signal.probability}%</strong><span>Estimated success</span></div>
    </div>
    <div className="opportunity-grid">
      <div><span>Entry</span><strong>{money(signal.entryLow, signal.asset)} – {money(signal.entryHigh, signal.asset)}</strong></div>
      <div><span>Current</span><strong>{money(signal.currentPrice, signal.asset)}</strong></div>
      <div><span>Status</span><Status value={signal.status} /></div>
    </div>
    <div className="view-link">View signal <ChevronRight /></div>
  </Link>;
}

function AssetCard({ asset }: { asset: Asset }) {
  const best = asset.signals.filter(s => s.probability).sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0];
  return <Link href={`/${asset.asset.toLowerCase()}`} className="asset-card">
    <div className="asset-card-head"><div><Mark asset={asset.asset} /><h2>{asset.asset}</h2><span>{asset.name}</span></div><ChevronRight /></div>
    <strong className="price">{money(asset.price, asset.asset)}</strong>
    <span className={asset.change24h >= 0 ? "positive" : "negative"}>{asset.change24h >= 0 ? "+" : ""}{asset.change24h.toFixed(2)}% 24H</span>
    <dl><div><dt>4H direction</dt><dd>{asset.marketDirection}</dd></div><div><dt>Best setup</dt><dd>{best?.type ?? "No valid entry"}</dd></div><div><dt>Probability</dt><dd>{best?.probability ? `${best.probability}%` : "—"}</dd></div></dl>
  </Link>;
}

function Home() {
  const { data, isLoading, error } = useOverview();
  return <main>
    <section className="intro"><p className="eyebrow">Cross-market trade intelligence</p><h1>SUI + DEEP SIGNALS</h1><p>Clear trade opportunities. Delivered by SMS.</p></section>
    {isLoading ? <div className="skeleton hero-skeleton" /> : error || !data ? <div className="empty">Live market data is temporarily unavailable.</div>
      : <>
        {data.bestOpportunity ? <Opportunity signal={data.bestOpportunity} /> : <div className="wait"><p className="eyebrow">Best opportunity</p><h2>WAIT.</h2><p>No high-quality entry right now.</p></div>}
        <div className="section-head"><h2>Markets</h2><span>Updated {new Date(data.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
        <div className="asset-grid">{data.assets.map(a => <AssetCard key={a.asset} asset={a} />)}</div>
        <div className="provisional">Model probabilities are provisional. Funding and Sui-native venue coverage are not yet healthy, so SMS dispatch is disabled.</div>
      </>}
  </main>;
}

function SignalCard({ signal }: { signal: Signal }) {
  if (!signal.probability) return <div className="signal-card muted-card"><div><p className="eyebrow">{signal.type}</p><h3>No valid setup</h3></div><Status value="WAITING" /></div>;
  return <Link href={`/signal/${signal.id}`} className="signal-card">
    <div><p className="eyebrow">{signal.type}</p><strong>{signal.probability}%</strong><span>{money(signal.entryLow, signal.asset)} – {money(signal.entryHigh, signal.asset)}</span></div>
    <div className="signal-side"><Status value={signal.status} /><small>T1 {money(signal.target1, signal.asset)}</small><small>Invalid {money(signal.invalidation, signal.asset)}</small></div>
  </Link>;
}

function AssetPage({ code }: { code: "SUI" | "DEEP" }) {
  const { data, isLoading } = useOverview();
  const asset = data?.assets.find(a => a.asset === code);
  if (isLoading) return <main><div className="skeleton hero-skeleton" /></main>;
  if (!asset) return <main className="empty">Market data unavailable.</main>;
  return <main>
    <section className="market-hero"><div><div className="asset-title"><Mark asset={code} /><h1>{code}</h1></div><strong>{money(asset.price, code)}</strong><span className={asset.change24h >= 0 ? "positive" : "negative"}>{asset.change24h.toFixed(2)}% 24H</span></div>
      <dl><div><dt>Market direction</dt><dd>{asset.marketDirection}</dd></div><div><dt>CEX / DEX convergence</dt><dd>{asset.convergenceDirection} · {asset.convergence}/100</dd></div><div><dt>Funding</dt><dd>{asset.fundingContext}</dd></div></dl>
    </section>
    <div className="section-head"><h2>Trade structures</h2><span>Exactly four monitored setups</span></div>
    <div className="signal-grid">{asset.signals.map(s => <SignalCard key={s.id} signal={s} />)}</div>
    <div className="section-head"><h2>Verified sources</h2><span>{asset.dataHealth} · {asset.dataHealthReason}</span></div>
    <div className="summary">
      <div><span>Coinbase price</span><strong>{asset.sourceHealth.cexPrice}</strong></div>
      <div><span>OKX derivatives</span><strong>{asset.sourceHealth.cexDerivatives}</strong></div>
      <div><span>DeepBook spot</span><strong>{asset.sourceHealth.suiNativeSpot}</strong></div>
      <div><span>Native spread</span><strong>{asset.nativeMarket.spreadBps === null ? "Missing" : `${asset.nativeMarket.spreadBps.toFixed(2)} bps`}</strong></div>
      <div><span>Funding</span><strong>{asset.derivatives.fundingRate === null ? "Missing" : `${(asset.derivatives.fundingRate * 100).toFixed(4)}%`}</strong></div>
      <div><span>Open interest</span><strong>{asset.derivatives.openInterestUsd === null ? "Missing" : `$${(asset.derivatives.openInterestUsd / 1_000_000).toFixed(1)}M`}</strong></div>
    </div>
  </main>;
}

function SignalDetail({ params }: { params: { id: string } }) {
  const { data, isLoading } = useOverview();
  const signal = data?.assets.flatMap(a => a.signals).find(s => s.id === params.id);
  if (isLoading) return <main><div className="skeleton hero-skeleton" /></main>;
  if (!signal) return <main className="empty">Signal not found.</main>;
  return <main>
    <section className="detail-head"><div><div className="asset-title"><Mark asset={signal.asset} /><h1>{signal.asset}</h1><Status value={signal.type} /></div><Status value={signal.status} /></div><div className="probability"><strong>{signal.probability ?? "—"}{signal.probability ? "%" : ""}</strong><span>Estimated success</span></div></section>
    <div className="metrics">{[["ENTRY", `${money(signal.entryLow, signal.asset)} – ${money(signal.entryHigh, signal.asset)}`], ["PREFERRED", money(signal.preferredEntry, signal.asset)], ["CURRENT", money(signal.currentPrice, signal.asset)], ["TARGET 1", money(signal.target1, signal.asset)], ["TARGET 2", money(signal.target2, signal.asset)], ["INVALIDATION", money(signal.invalidation, signal.asset)], ["R:R TO T1", signal.rrToT1.toFixed(1)]].map(([k,v]) => <div key={k}><span>{k}</span><strong>{v}</strong></div>)}</div>
    <section className="convergence"><div><p className="eyebrow">Market convergence</p><h2>{signal.convergenceDirection}</h2></div><strong>{signal.convergence}<span>/100</span></strong></section>
    <div className="summary">{[["4H", signal.timeframe.fourHour], ["1H", signal.timeframe.oneHour], ["15M", signal.timeframe.fifteenMinute], ["CEX Funding", signal.fundingContext], ["Sui Perps", "Missing"], ["Sui Spot", "Missing"]].map(([k,v]) => <div key={k}><span>{k}</span><strong>{v}</strong></div>)}</div>
    <div className="chart-placeholder"><p>Chart</p><h3>Market overlays will appear when the candle store is active.</h3><span>15M &nbsp; 1H &nbsp; 4H</span></div>
  </main>;
}

function Placeholder({ title, copy, icon }: { title: string; copy: string; icon?: ReactNode }) {
  return <main><section className="intro">{icon}<p className="eyebrow">SUI + DEEP SIGNALS</p><h1>{title}</h1><p>{copy}</p></section><div className="empty"><h2>Not active yet.</h2><p>This section will activate after verified data, delivery, and entitlement infrastructure is ready.</p></div></main>;
}

function AlertsPage() {
  const { data, isLoading } = useOverview();
  const assets = data?.assets ?? [];
  const marketLive = assets.length === 2 && assets.every(asset => asset.sourceHealth.cexPrice === "LIVE");
  const sui = assets.find(asset => asset.asset === "SUI");
  const deep = assets.find(asset => asset.asset === "DEEP");
  return <main>
    <section className="intro"><Bell /><p className="eyebrow">SUI + DEEP SIGNALS</p><h1>SMS signals</h1><p>SUI and DEEP trade opportunities delivered directly to your phone.</p></section>
    <div className="status-panel">
      <div><span>Market engine</span><Status value={isLoading ? "CHECKING" : marketLive ? "LIVE" : "DEGRADED"} /></div>
      <div><span>SUI data</span><Status value={sui?.dataHealth ?? "CHECKING"} /></div>
      <div><span>DEEP data</span><Status value={deep?.dataHealth ?? "CHECKING"} /></div>
      <div><span>SMS service</span><Status value="NOT CONFIGURED" /></div>
      <div><span>Last updated</span><strong>{data ? new Date(data.updatedAt).toLocaleTimeString() : "—"}</strong></div>
    </div>
    <div className="provisional">Outside subscriptions remain closed. SMS will not activate until a production test is delivered, U.S. sender compliance is confirmed, and all rollout gates pass.</div>
  </main>;
}

function AppRoutes() {
  return <Layout><ErrorBoundary><Switch>
    <Route path="/" component={Home} />
    <Route path="/sui">{() => <AssetPage code="SUI" />}</Route>
    <Route path="/deep">{() => <AssetPage code="DEEP" />}</Route>
    <Route path="/signal/:id" component={SignalDetail} />
    <Route path="/performance">{() => <Placeholder title="Performance" copy="Forward results, never rewritten." />}</Route>
    <Route path="/alerts" component={AlertsPage} />
    <Route path="/account">{() => <Placeholder title="Account" copy="Phone verification and alert preferences." icon={<Settings2 />} />}</Route>
    <Route>{() => <Placeholder title="Not found" copy="This page does not exist." />}</Route>
  </Switch></ErrorBoundary></Layout>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><AppRoutes /></QueryClientProvider>;
}