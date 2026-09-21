import { Component, type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectButton, useCurrentAccount, useSignPersonalMessage } from "@mysten/dapp-kit";
import { Link, Route, Switch, useLocation } from "wouter";
import { Activity, AlertTriangle, ArrowUpFromLine, Check, CirclePause, Database, FlaskConical, Gauge, Menu, Play, RefreshCw, Settings, ShieldCheck, SquareStack, WalletCards, X } from "lucide-react";
import "./auth.css";

type Auth = { authenticated: boolean; walletAddress: string | null; network: string };
type Dashboard = {
  mode?: string; paperEquitySui?: string | null; mainnetLiquidSui?: string | null; mainnetLiquidationSui?: string | null;
  mainnetRealizedPnlSui?: string | null; returnedSui?: string | null; positions?: unknown[];
  recentTransactions?: Array<Record<string, unknown>>; decisionStatus?: string; blockers?: string[]; updatedAt?: string;
  wallet?: { connectedAddress?: string };
};
type Operations = {
  collector?: unknown; worker?: unknown; signer?: unknown; chain?: string; network?: string; replay?: unknown;
  reconciliation?: unknown; policyVersion?: string; intelligence?: unknown; costs?: unknown; blockers?: string[];
};

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="error-state"><AlertTriangle /><h1>Application unavailable</h1><p>No balance or activity will be inferred while the interface is unavailable.</p><button onClick={() => location.reload()}>Reload</button></main> : this.props.children; }
}

const nav = [["/", "Overview"], ["/paper", "Paper Agent"], ["/mainnet", "Mainnet Agent"], ["/activity", "Activity"], ["/risk", "Risk"], ["/settings", "Settings"]] as const;
const fmt = (v?: string | null, digits = 4) => {
  if (v === null || v === undefined || v === "") return "Unavailable";
  const n = Number(v); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : "Unavailable";
};
const short = (v?: string | null) => v ? `${v.slice(0, 8)}…${v.slice(-6)}` : "Not connected";
const label = (v: unknown) => typeof v === "string" ? v : v && typeof v === "object" && "status" in v ? String((v as { status?: unknown }).status) : "Not reported";
const prettyTime = (v?: string) => v ? new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Awaiting snapshot";

function useSnapshot<T>(path: string, enabled = true) {
  return useQuery<T>({ queryKey: [path], enabled, queryFn: async () => { const r = await fetch(path); if (!r.ok) throw new Error("Request failed"); return r.json() as Promise<T>; }, refetchInterval: 30000 });
}
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
function Loading() { return <div className="skeleton-stack"><div className="skeleton wide" /><div className="skeleton" /></div>; }
function Blockers({ blockers }: { blockers?: string[] }) { return blockers?.length ? <div className="blocker-list">{blockers.map((b) => <div key={b}><AlertTriangle /><span>{b}</span></div>)}</div> : <div className="clear-state"><Check />No blockers reported.</div>; }
function Metric({ title, value, tag, icon }: { title: string; value: string; tag: "PAPER" | "MAINNET"; icon: ReactNode }) {
  return <article className="metric-card"><div className="metric-icon">{icon}</div><Badge tone={tag.toLowerCase()}>{tag}</Badge><span>{title}</span><strong>{value}</strong></article>;
}

function WalletAuthentication({ auth, refresh }: { auth?: Auth; refresh: () => Promise<unknown> }) {
  const account = useCurrentAccount();
  const signer = useSignPersonalMessage();
  const [message, setMessage] = useState("");
  const authenticated = auth?.authenticated && auth.walletAddress?.toLowerCase() === account?.address.toLowerCase();
  useEffect(() => { if (auth?.authenticated && account && auth.walletAddress?.toLowerCase() !== account.address.toLowerCase()) void fetch("/api/auth/logout", { method: "POST" }).then(() => refresh()); }, [account?.address]);
  const authenticate = async () => {
    if (!account) return;
    setMessage("");
    try {
      const challengeResponse = await fetch(`/api/auth/challenge?address=${encodeURIComponent(account.address)}`);
      const challenge = await challengeResponse.json() as { message?: string };
      if (!challengeResponse.ok || !challenge.message) throw new Error("Could not create a login challenge.");
      const signed = await signer.mutateAsync({ message: new TextEncoder().encode(challenge.message) });
      const response = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address, signature: signed.signature }) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "Signature verification failed.");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet authentication failed."); }
  };
  return <div className="wallet-actions"><ConnectButton connectText="Connect Sui Wallet" />{account && !authenticated && <button className="auth-button" onClick={authenticate} disabled={signer.isPending}>{signer.isPending ? "Check wallet…" : "Sign in"}</button>}{authenticated && <Badge tone="healthy">Authenticated</Badge>}{message && <span className="auth-error">{message}</span>}</div>;
}

function Layout({ auth, refresh, children }: { auth?: Auth; refresh: () => Promise<unknown>; children: ReactNode }) {
  const [path] = useLocation(); const [open, setOpen] = useState(false);
  return <div className="app-shell"><header className="topbar"><Link href="/" className="wordmark"><span className="sui-mark">S</span><span>BLUE WATER <b>AGENTS</b></span></Link><button className="menu-button" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button><nav className={open ? "nav open" : "nav"}>{nav.map(([href, title]) => <Link key={href} href={href} className={path === href ? "active" : ""} onClick={() => setOpen(false)}>{title}</Link>)}</nav><WalletAuthentication auth={auth} refresh={refresh} /></header>{children}<footer><span>Autonomous SUI accumulation through Suipump</span><span>Mainnet execution remains blocked until verified</span></footer></div>;
}

function PublicHome({ auth }: { auth?: Auth }) {
  if (auth?.authenticated) return <Overview />;
  return <main><section className="landing-hero"><p className="eyebrow">Blue Water Agents / Sui Mainnet</p><h1>Accumulate SUI.<br/><em>With evidence.</em></h1><p>Connect your Sui wallet. Choose Paper or Mainnet. Blue Water Agents monitors Suipump tokens and attempts to accumulate SUI automatically.</p><div className="trust-row"><span><ShieldCheck />Wallet-signed access</span><span><Database />Chain-derived data</span><span><Gauge />Capped risk</span></div></section><section className="agent-choice"><article><Badge tone="paper">PAPER — NO REAL FUNDS</Badge><FlaskConical /><h2>Paper Agent</h2><p>Starts with exactly 10 virtual SUI and follows live Sui Mainnet observations. Decisions are timestamped and never rewritten.</p><ul><li>Live Suipump observations</li><li>Same eligibility and risk gates</li><li>No real transfers or signatures</li></ul></article><article className="mainnet-choice"><Badge tone="mainnet">MAINNET — REAL FUNDS AT RISK</Badge><WalletCards /><h2>Mainnet Agent</h2><p>A dedicated, isolated agent architecture for verified Suipump contracts. Provisioning remains blocked until the complete return path is proven.</p><ul><li>Maximum 1 SUI canary funding</li><li>Maximum 0.1 SUI first trade</li><li>Withdraw and revoke controls required</li></ul></article></section></main>;
}

function Overview() {
  const { data, isLoading, error, refetch } = useSnapshot<Dashboard>("/api/accumulation/dashboard");
  if (isLoading) return <main><Loading /></main>;
  if (error || !data) return <main className="error-state"><AlertTriangle /><h1>Wallet dashboard unavailable</h1><p>Authenticate this connected wallet to view its agent.</p><button onClick={() => refetch()}><RefreshCw />Retry</button></main>;
  return <main><section className="hero"><div><p className="eyebrow">Wallet-specific agent / Sui Mainnet</p><h1>Your SUI agent.</h1><p className="hero-copy">Paper and Mainnet accounting are always separated. Unverified values remain unavailable.</p></div><div className="mode-panel"><span>Connected wallet</span><strong>{short(data.wallet?.connectedAddress)}</strong><Badge tone="paper">{data.mode || "PAPER"}</Badge></div></section><div className="metric-grid"><Metric title="Paper equity" value={`${fmt(data.paperEquitySui)} SUI`} tag="PAPER" icon={<FlaskConical />} /><Metric title="Liquid SUI" value={`${fmt(data.mainnetLiquidSui)} SUI`} tag="MAINNET" icon={<WalletCards />} /><Metric title="Liquidation value" value={`${fmt(data.mainnetLiquidationSui)} SUI`} tag="MAINNET" icon={<ArrowUpFromLine />} /><Metric title="Realized P&L" value={`${fmt(data.mainnetRealizedPnlSui)} SUI`} tag="MAINNET" icon={<Activity />} /></div><section className="lower-grid"><div className="panel"><div className="section-heading"><div><p className="eyebrow">Current decision</p><h2>Fail closed</h2></div><Badge>HOLD SUI</Badge></div><p>{data.decisionStatus}</p></div><div className="panel"><div className="section-heading"><div><p className="eyebrow">Open gates</p><h2>Blockers</h2></div><AlertTriangle /></div><Blockers blockers={data.blockers} /></div></section><p className="snapshot-note">Wallet-scoped snapshot · {prettyTime(data.updatedAt)}</p></main>;
}

function PaperPage() {
  const { data, refetch } = useSnapshot<Dashboard>("/api/accumulation/dashboard");
  const action = async (path: string) => { await fetch(path, { method: "POST" }); await refetch(); };
  return <main><section className="hero compact"><div><p className="eyebrow">PAPER — NO REAL FUNDS</p><h1>Forward-only simulation.</h1><p className="hero-copy">The campaign starts with exactly 10 virtual SUI. No fill is accepted without an executable quote and successful Mainnet simulation.</p></div><div className="mode-panel"><span>Paper equity</span><strong>{fmt(data?.paperEquitySui)} SUI</strong><Badge tone="paper">{data?.mode || "PAPER"}</Badge></div></section><section className="action-panel"><div><p className="eyebrow">Paper controls</p><h2>Deterministic decisions only.</h2><p>No random returns, hindsight prices, or fake digests.</p></div><div className="actions"><button onClick={() => action("/api/accumulation/resume-paper")}><Play />Resume</button><button onClick={() => action("/api/accumulation/pause")}><CirclePause />Pause</button></div></section><section className="panel"><h2>Current result</h2><p>{data?.decisionStatus || "Awaiting a wallet-scoped campaign."}</p><Blockers blockers={data?.blockers} /></section></main>;
}

function MainnetPage() { return <main><section className="hero compact"><div><p className="eyebrow">MAINNET — REAL FUNDS AT RISK</p><h1>Execution is blocked.</h1><p className="hero-copy">Create Mainnet Agent will unlock only after package lineage, buy and sell routes, isolated custody, reconciliation, and the bounded return path are verified.</p></div><Badge tone="blocked">Not provisionable</Badge></section><section className="panel"><h2>Canary limits</h2><div className="risk-grid"><span>Maximum funded balance<strong>1 SUI</strong></span><span>Maximum first trade<strong>0.1 SUI</strong></span><span>Simultaneous positions<strong>2</strong></span><span>Leverage<strong>None</strong></span></div><button className="disabled-cta" disabled>Create Mainnet Agent — blocked</button></section></main>; }

function OperationsPage({ title = "System activity" }: { title?: string }) {
  const { data, isLoading } = useSnapshot<Operations>("/api/accumulation/operations");
  if (isLoading) return <main><Loading /></main>;
  const rows = [["Collector", data?.collector], ["Paper worker", data?.worker], ["Mainnet executor", "BLOCKED"], ["Signer", data?.signer], ["Database", "AVAILABLE"], ["Sui provider", data?.collector], ["Suipump adapter", "PARTIAL"], ["Replay", data?.replay]] as const;
  return <main><section className="hero compact"><div><p className="eyebrow">Operational evidence</p><h1>{title}</h1><p className="hero-copy">Website availability is not worker health. Each dependency is reported separately.</p></div><div className="network-card"><Database /><span>{data?.chain || "Sui"}</span><strong>{data?.network || "mainnet"}</strong></div></section><section className="panel"><div className="ops-grid">{rows.map(([name, value]) => <div key={name}><span>{name}</span><Badge tone={label(value).toLowerCase()}>{label(value)}</Badge></div>)}</div></section><section className="panel blocker-panel"><Blockers blockers={data?.blockers} /></section></main>;
}

function RiskPage() { return <main><section className="hero compact"><div><p className="eyebrow">Hard policy</p><h1>Risk cannot be negotiated by AI.</h1></div></section><section className="panel"><div className="risk-grid"><span>Accounting asset<strong>SUI</strong></span><span>Average down<strong>Never</strong></span><span>Unlimited slippage<strong>Rejected</strong></span><span>Unknown lineage<strong>Rejected</strong></span><span>Positive minimum output<strong>Required</strong></span><span>Exit quote before entry<strong>Required</strong></span></div></section></main>; }
function SettingsPage() { return <main><section className="hero compact"><div><p className="eyebrow">Wallet-scoped settings</p><h1>Authorization, not custody.</h1><p className="hero-copy">Blue Water Agents will never request a seed phrase or primary-wallet private key. Mainnet authorization controls remain unavailable until secure per-user custody is proven.</p></div><Settings /></section><section className="panel"><h2>Mainnet controls</h2><div className="actions settings-actions"><button disabled>Revoke Authorization</button><button disabled>Withdraw Available SUI</button><button disabled>Withdraw All</button></div></section></main>; }

function AppRoutes({ auth, refresh }: { auth?: Auth; refresh: () => Promise<unknown> }) {
  return <Layout auth={auth} refresh={refresh}><ErrorBoundary><Switch><Route path="/">{() => <PublicHome auth={auth} />}</Route><Route path="/paper">{() => auth?.authenticated ? <PaperPage /> : <PublicHome auth={auth} />}</Route><Route path="/mainnet" component={MainnetPage} /><Route path="/activity">{() => <OperationsPage />}</Route><Route path="/risk" component={RiskPage} /><Route path="/settings" component={SettingsPage} /><Route>{() => <main className="error-state"><h1>Page not found</h1><Link href="/">Return home</Link></main>}</Route></Switch></ErrorBoundary></Layout>;
}

export default function App() {
  return <AppInner />;
}
function AppInner() {
  const { data, refetch } = useSnapshot<Auth>("/api/auth/status");
  return <AppRoutes auth={data} refresh={refetch} />;
}