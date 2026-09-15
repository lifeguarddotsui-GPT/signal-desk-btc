import { Component, type ReactNode, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, Route, Switch, useLocation } from "wouter";
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CirclePause, Clock3, Copy, Database, Menu, RefreshCw, ShieldCheck, SquareStack, WalletCards, X } from "lucide-react";
import { queryClient } from "./lib/queryClient";
import "./auth.css";

type Dashboard = {
  mode?: string; liquidSui?: string | null; gasReserveSui?: string | null; estimatedLiquidationSui?: string | null; realizedNetProfitSui?: string | null;
  returnedSui?: string | null; campaignDepositSui?: string | null; campaignTargetSui?: string | null; estimatedCampaignValueSui?: string | null;
  positions?: unknown[]; recentTransactions?: Array<Record<string, unknown>>; decisionStatus?: string; blockers?: string[]; updatedAt?: string;
};
type Operations = {
  collector?: unknown; worker?: unknown; signer?: unknown; chain?: string; network?: string; replay?: unknown;
  reconciliation?: unknown; policyVersion?: string; intelligence?: unknown; costs?: unknown; blockers?: string[];
};

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="error-state"><AlertTriangle /><h1>Console unavailable</h1><p>The treasury snapshot could not be rendered.</p><button onClick={() => location.reload()}>Reload console</button></main> : this.props.children; }
}

const nav = [["/", "Overview"], ["/operations", "Operations"]] as const;
const fmt = (v?: string | null, digits = 4) => {
  if (v === null || v === undefined || v === "") return "Unavailable";
  const number = Number(v);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits }) : "Unavailable";
};
const label = (v: unknown) => typeof v === "string" ? v : v === true ? "Healthy" : v === false ? "Not ready" : v && typeof v === "object" && "status" in v ? String((v as { status?: unknown }).status) : "Not reported";
const prettyTime = (value?: string) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Awaiting snapshot";

function useSnapshot<T>(path: string) {
  return useQuery<T>({ queryKey: [path], queryFn: async () => { const response = await fetch(path); if (!response.ok) throw new Error("Request failed"); return response.json() as Promise<T>; }, refetchInterval: 30000 });
}
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
function ModeBadge({ mode }: { mode?: string }) { const value = mode || "Observe"; return <Badge tone={value.toLowerCase()}>{value}</Badge>; }
function Loading() { return <div className="skeleton-stack" aria-label="Loading snapshot"><div className="skeleton wide" /><div className="skeleton" /><div className="skeleton" /></div>; }

function Layout({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [open, setOpen] = useState(false);
  return <div className="app-shell">
    <header className="topbar">
      <Link href="/" className="wordmark"><span className="sui-mark">S</span><span>BLUE WATER <b>AGENTS</b></span></Link>
      <button className="menu-button" onClick={() => setOpen(!open)} aria-label="Toggle navigation">{open ? <X /> : <Menu />}</button>
      <nav className={open ? "nav open" : "nav"}>{nav.map(([href, title]) => <Link key={href} href={href} className={path === href ? "active" : ""} onClick={() => setOpen(false)}>{title}</Link>)}</nav>
      <div className="owner-pill"><span className="pulse" /> Private console</div>
    </header>
    {children}
    <footer><span>Single-owner accumulation experiment</span><span>Read-only telemetry unless explicitly enabled</span></footer>
  </div>;
}

function ActionBar() {
  const [notice, setNotice] = useState("");
  const action = async (name: string, path?: string) => {
    if (!path) {
      setNotice(`${name} is unavailable until a dedicated agent wallet is configured.`);
      return;
    }
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" } });
      const body = await response.json() as { message?: string };
      setNotice(body.message || `${name} returned ${response.status}.`);
    } catch {
      setNotice(`${name} could not reach the control service.`);
    }
  };
  return <section className="action-panel">
    <div><p className="eyebrow">Controls</p><h2>Intentional moves only.</h2><p>Every action is gated by the current mode, signer health, and risk policy.</p></div>
    <div className="actions">
      <button onClick={() => action("Deposit SUI")}><ArrowDownToLine /> Deposit SUI</button>
      <button onClick={() => action("Pause", "/api/accumulation/pause")}><CirclePause /> Pause</button>
      <button className="danger" onClick={() => action("Withdraw All", "/api/accumulation/withdraw-all")}><ArrowUpFromLine /> Withdraw All</button>
    </div>
    {notice && <div className="refusal" role="status"><AlertTriangle />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X /></button></div>}
  </section>;
}

function SnapshotCard({ title, value, detail, icon }: { title: string; value: string; detail?: string; icon: ReactNode }) {
  return <article className="metric-card"><div className="metric-icon">{icon}</div><span>{title}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
}

function Blockers({ blockers }: { blockers?: string[] }) {
  if (!blockers?.length) return <div className="clear-state"><Check /> No blockers reported in the latest snapshot.</div>;
  return <div className="blocker-list">{blockers.map((item, i) => <div key={`${item}-${i}`}><AlertTriangle /><span>{item}</span></div>)}</div>;
}

function Overview() {
  const { data, isLoading, error, refetch, dataUpdatedAt } = useSnapshot<Dashboard>("/api/accumulation/dashboard");
  if (isLoading) return <main><Loading /></main>;
  if (error || !data) return <main className="error-state"><AlertTriangle /><h1>Snapshot unavailable</h1><p>We will not invent a balance, position, or activity history.</p><button onClick={() => refetch()}><RefreshCw /> Try again</button></main>;
  return <main>
    <section className="hero">
      <div><p className="eyebrow">Personal treasury console / SUI</p><h1>Hold with intent.</h1><p className="hero-copy">A quiet, disciplined view of one high-risk accumulation experiment. No noise. No borrowed certainty.</p></div>
      <div className="mode-panel"><span>Current mode</span><ModeBadge mode={data.mode} /><small>Snapshot {prettyTime(data.updatedAt)}{dataUpdatedAt ? "" : ""}</small></div>
    </section>
    <ActionBar />
    <section className="section-heading"><div><p className="eyebrow">Treasury snapshot</p><h2>What is actually held</h2></div><span className="live-note"><span className="pulse" /> polling every 30s</span></section>
    <div className="metric-grid">
      <SnapshotCard title="Liquid SUI" value={`${fmt(data.liquidSui)} SUI`} detail="Available for the experiment" icon={<WalletCards />} />
      <SnapshotCard title="Gas reserve" value={`${fmt(data.gasReserveSui)} SUI`} detail="Kept separate from campaign capital" icon={<Activity />} />
      <SnapshotCard title="Estimated liquidation" value={`${fmt(data.estimatedLiquidationSui)} SUI`} detail="Backend estimate, not a promise" icon={<ArrowUpFromLine />} />
      <SnapshotCard title="Realized net profit" value={`${fmt(data.realizedNetProfitSui)} SUI`} detail="Recorded only when realized" icon={<ShieldCheck />} />
    </div>
    <section className="campaign-card">
      <div className="section-heading"><div><p className="eyebrow">Accumulation campaign</p><h2>Capital with a boundary</h2></div><Badge>{data.decisionStatus || "Decision pending"}</Badge></div>
      <div className="campaign-values"><div><span>Deposited</span><strong>{fmt(data.campaignDepositSui)} <em>SUI</em></strong></div><div><span>Target</span><strong>{fmt(data.campaignTargetSui)} <em>SUI</em></strong></div><div><span>Estimated value</span><strong>{fmt(data.estimatedCampaignValueSui)} <em>SUI</em></strong></div></div>
      <div className="progress-track"><span style={{ width: `${Math.min(100, Math.max(0, (Number(data.estimatedCampaignValueSui || 0) / Math.max(1, Number(data.campaignTargetSui || 1))) * 100))}%` }} /></div>
    </section>
    <section className="lower-grid">
      <div className="panel"><div className="section-heading"><div><p className="eyebrow">Risk gate</p><h2>Blockers</h2></div><AlertTriangle /></div><Blockers blockers={data.blockers} /></div>
      <div className="panel"><div className="section-heading"><div><p className="eyebrow">Activity</p><h2>Recent transactions</h2></div><Clock3 /></div>{data.recentTransactions?.length ? <div className="transaction-list">{data.recentTransactions.map((tx, i) => <div key={i}><span>{String(tx.type || tx.kind || "Transaction")}</span><strong>{String(tx.amount || tx.sui || "Amount not reported")} <small>SUI</small></strong></div>)}</div> : <div className="empty-inline"><SquareStack /><span>No transactions reported yet.</span></div>}</div>
    </section>
    <p className="snapshot-note">Snapshot updated {prettyTime(data.updatedAt)} · {data.positions?.length ? `${data.positions.length} position${data.positions.length === 1 ? "" : "s"} reported` : "No positions reported"}</p>
  </main>;
}

const opRows = [["Collector", "collector"], ["Worker", "worker"], ["Signer", "signer"], ["Replay protection", "replay"], ["Reconciliation", "reconciliation"], ["Intelligence", "intelligence"], ["Cost accounting", "costs"]] as const;
function OperationsPage() {
  const { data, isLoading, error, refetch } = useSnapshot<Operations>("/api/accumulation/operations");
  if (isLoading) return <main><Loading /></main>;
  if (error || !data) return <main className="error-state"><AlertTriangle /><h1>Operations unavailable</h1><p>System health remains unknown until the API responds.</p><button onClick={() => refetch()}><RefreshCw /> Try again</button></main>;
  return <main><section className="hero compact"><div><p className="eyebrow">Operational health</p><h1>Know the plumbing.</h1><p className="hero-copy">The experiment only moves when collection, signing, and reconciliation agree.</p></div><div className="network-card"><Database /><span>{data.chain || "Chain not reported"}</span><strong>{data.network || "Network not reported"}</strong></div></section>
    <section className="panel operations-panel"><div className="section-heading"><div><p className="eyebrow">System checks</p><h2>What can stop a move</h2></div><Badge tone={data.blockers?.length ? "blocked" : "healthy"}>Current snapshot</Badge></div><div className="ops-grid">{opRows.map(([name, key]) => <div key={key}><span>{name}</span><Badge tone={label(data[key]).toLowerCase()}>{label(data[key])}</Badge></div>)}</div></section>
    <section className="policy-panel"><button className="policy-toggle" onClick={(e) => { const next = e.currentTarget.parentElement?.querySelector(".policy-copy"); next?.classList.toggle("visible"); }}><div><p className="eyebrow">Read-only guardrail</p><h2>Risk policy <span>{label(data.policyVersion)}</span></h2></div><ChevronDown /></button><div className="policy-copy"><p>Policy is deliberately collapsed here. This console does not infer permissions, signer identity, or thresholds from missing data.</p><div><ShieldCheck /> No policy mutation controls are exposed in this experiment.</div></div></section>
    <section className="panel"><div className="section-heading"><div><p className="eyebrow">Operational blockers</p><h2>Open gates</h2></div><Copy /></div><Blockers blockers={data.blockers} /></section>
  </main>;
}

function AppRoutes() { return <Layout><ErrorBoundary><Switch><Route path="/" component={Overview} /><Route path="/operations" component={OperationsPage} /><Route>{() => <main className="error-state"><h1>Page not found</h1><p>This console has only two operational views.</p><Link href="/">Return to overview</Link></main>}</Route></Switch></ErrorBoundary></Layout>; }

function OwnerGate() {
  const { data, isLoading, refetch } = useSnapshot<{ authenticated: boolean; ownerControlConfigured: boolean }>("/api/auth/status");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await response.json() as { message?: string };
    if (!response.ok) {
      setMessage(body.message || "Owner authentication failed.");
      return;
    }
    setToken("");
    await refetch();
  };
  if (isLoading) return <Loading />;
  if (data?.authenticated) return <AppRoutes />;
  return <main className="auth-shell">
    <div className="auth-mark">S</div>
    <p className="eyebrow">Blue Water Agents</p>
    <h1>Private treasury console</h1>
    <p>{data?.ownerControlConfigured ? "Enter the owner control passphrase to continue." : "Owner access is not configured. Add OWNER_CONTROL_TOKEN to production secrets before using this console."}</p>
    <form onSubmit={login}>
      <label htmlFor="owner-token">Owner passphrase</label>
      <input id="owner-token" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} disabled={!data?.ownerControlConfigured} />
      <button type="submit" disabled={!data?.ownerControlConfigured || token.length === 0}>Open console</button>
    </form>
    {message && <div className="refusal" role="alert"><AlertTriangle />{message}</div>}
  </main>;
}

export default function App() { return <QueryClientProvider client={queryClient}><OwnerGate /></QueryClientProvider>; }