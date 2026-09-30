import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { Activity, ArrowDownRight, ArrowUpRight, BookOpen, ChevronDown, CircleHelp, Clock3, Database, ExternalLink, Menu, RefreshCw, ShieldCheck, Waves, X } from "lucide-react";
import { inspectedPointKey, pointerTimestamp } from "./chart-contract";
import { indicativeGross, insertTimestampGaps, isActiveWaterxRound, isCoinbaseSource, isFreshWaterxSnapshot, isWaterxMarketSource, resetSseCursor, sseReconnectUrl, SETTLEMENT_SOURCE_LABEL } from "./waterx-ui-contract";
import { mergeComparisonPoints } from "./chart-contract";
import { browserRenderSummary, recordBrowserRender } from "./browser-latency";

type Interval = 5 | 15;
type Point = { at: number | string; price: number | null; source?: string; sourceAt?: number | string | null; eventId?: string | number; gap?: boolean; reason?: string };
type LivePayload = {
  serverTime?: string; status?: string; intervalMinutes?: number; reason?: string;
  round?: { id: string; startMs: number; expiryMs: number; referencePrice: number; anchorConfirmed: boolean; phase?: string; url?: string } | null;
  odds?: { up: number; down: number; upPriceCents: number; downPriceCents: number; asOf: string; source: string } | null;
  comparison?: { price: number; asOf: string; source: string } | null;
  decision?: { action: "HOLD" | string; reason: string };
  learning?: Record<string, unknown>;
};
type ChartPayload = { windowMinutes: number; source: string; points: Point[]; coverage?: { startMs?: number; endMs?: number; expectedSamples?: number; observedSamples?: number; percent?: number; partial?: boolean; reason?: string } };

function useApi<T>(url: string, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [errorUrl, setErrorUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState("");
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);
  const reload = useCallback(() => setNonce(v => v + 1), []);
  useEffect(() => {
    let active = true;
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => controller.abort(new Error("Request timed out after 9 seconds.")), 9000);
    fetch(url, { signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error(`Request failed (${r.status})`); return r.json() as Promise<T>; })
      .then(result => { if (active && requestId.current === id) { setData(result); setLoadedUrl(url); setError(""); setErrorUrl(""); setUpdated(Date.now()); } })
      .catch(e => { if (active && requestId.current === id) { setError(e instanceof Error ? e.message : "Could not load this data."); setErrorUrl(url); } })
      .finally(() => { clearTimeout(timer); if (active && requestId.current === id) setLoading(false); });
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [url, nonce]);
  useEffect(() => {
    if (!refreshMs || loading) return;
    let disposed = false;
    const timer = window.setTimeout(() => { if (!disposed) reload(); }, refreshMs);
    return () => { disposed = true; clearTimeout(timer); };
  }, [url, refreshMs, reload, loading]);
  return { data, error, errorUrl, loading, updated, loadedUrl, reload };
}

function useIntervalPreference() {
  const [value, setValue] = useState<Interval>(() => {
    try { return window.localStorage.getItem("bluewater.interval") === "15" ? 15 : 5; }
    catch { return 5; }
  });
  const change = useCallback((next: Interval) => {
    setValue(next);
    try { window.localStorage.setItem("bluewater.interval", String(next)); } catch { /* storage may be unavailable */ }
  }, []);
  return [value, change] as const;
}

const fmtUsd = (value?: number | null) => value == null || !Number.isFinite(value)
  ? "—" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtOdds = (value?: number | null) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}¢`;
const fmtProbability = (value?: number | null) => value == null || !Number.isFinite(value) || value < 0 || value > 1 ? "—" : `${(value * 100).toFixed(1)}%`;
const ago = (value?: string | number) => {
  if (value == null) return "not reported";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "timestamp unavailable";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
};
const utc = (value?: string | number) => value == null ? "—" : new Date(value).toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " UTC";
const timeRemaining = (expiry: number, now: number) => {
  const seconds = Math.max(0, Math.ceil((expiry - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
function Skeleton({ height = 220 }: { height?: number }) { return <div className="skeleton" style={{ height }} aria-label="Loading data" />; }
function ErrorBox({ message, retry }: { message: string; retry: () => void }) {
  return <div className="errorbox"><strong>Desk connection interrupted</strong><p>{message}</p><button className="quiet-button" onClick={retry}><RefreshCw size={15} /> Try again</button></div>;
}
function PageTitle({ index, title, children }: { index: string; title: string; children?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow">{index} / BLUEWATER RESEARCH</div><h1>{title}</h1></div>{children}</div>;
}
function Shell({ children }: { children: ReactNode }) {
  const [path] = useLocation(); const [open, setOpen] = useState(false);
  const nav = [{ href: "/", label: "Live desk", icon: Activity }, { href: "/history", label: "Round history", icon: Clock3 }, { href: "/learn", label: "Learning", icon: BookOpen }, { href: "/health", label: "Data health", icon: Database }];
  return <div className="app-shell">
    <header className="masthead">
      <Link href="/" className="wordmark" onClick={() => setOpen(false)}><span className="mark"><Waves size={19} strokeWidth={2.2} /></span><span>bluewater<span className="wordmark-ai">AI</span><small>BTC ROUND RESEARCH</small></span></Link>
      <button className="mobile-menu" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen(v => !v)}>{open ? <X size={20} /> : <Menu size={20} />}</button>
      <nav className={open ? "main-nav nav-open" : "main-nav"} aria-label="Main navigation">{nav.map(item => {
        const Icon = item.icon; return <Link key={item.href} href={item.href} className={path === item.href ? "nav-link current" : "nav-link"} onClick={() => setOpen(false)}><Icon size={15} />{item.label}</Link>;
      })}</nav>
      <div className="top-status"><i /> READ ONLY <span>·</span> BTC / USD</div>
    </header>
    <main>{children}</main>
    <footer className="site-footer"><span>BLUEWATERAI <b>·</b> MARKET OBSERVATION, NOT EXECUTION</span><span>UTC time · no wallet · no orders</span></footer>
  </div>;
}

function IntervalSwitch({ value, onChange }: { value: Interval; onChange: (n: Interval) => void }) {
  return <div className="interval-switch" role="group" aria-label="Prediction round interval">
    {([5, 15] as const).map(n => <button key={n} className={value === n ? "selected" : ""} aria-pressed={value === n} onClick={() => onChange(n)}>{n}<small>MIN</small></button>)}
  </div>;
}

function LivePage() {
  const [interval, setInterval] = useIntervalPreference();
  const [chartWindow, setChartWindow] = useState<"round" | 5 | 15>("round");
  const [indicativeAmount, setIndicativeAmount] = useState("5");
  const [now, setNow] = useState(Date.now());
  const liveUrl = `/api/waterx/live?interval=${interval}`;
  const chartUrl = `/api/waterx/chart?interval=${interval}&window=${chartWindow === "round" ? interval : chartWindow}`;
  const live = useApi<LivePayload>(liveUrl, 3000);
  const chart = useApi<ChartPayload>(chartUrl, 30000);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const payload = live.loadedUrl === liveUrl ? live.data : null;
  const round = payload?.round ?? null;
  const serverMs = payload?.serverTime ? Date.parse(payload.serverTime) : NaN;
  const serverNow = Number.isFinite(serverMs) ? now + (serverMs - live.updated) : now;
  const snapshotToleranceMs = interval === 5 ? 16_000 : 31_000;
  const snapshotCurrent = !live.error && live.loadedUrl === liveUrl &&
    isFreshWaterxSnapshot(live.updated, payload?.serverTime, now, snapshotToleranceMs) &&
    payload?.intervalMinutes === interval;
  const roundCurrent = snapshotCurrent && !!round && isActiveWaterxRound(payload?.intervalMinutes, interval, round.startMs, round.expiryMs, serverNow);
  const comparison = payload?.comparison;
  const comparisonMs = comparison?.asOf ? Date.parse(comparison.asOf) : NaN;
  const comparisonFresh = !!comparison && Number.isFinite(comparisonMs) &&
    comparisonMs <= (Number.isFinite(serverNow) ? serverNow : now) + 1000 &&
    now - comparisonMs <= 14000 && now - comparisonMs >= -1000 &&
    isCoinbaseSource(comparison.source);
  const odds = payload?.odds;
  const oddsMs = odds?.asOf ? Date.parse(odds.asOf) : NaN;
  const oddsFresh = !!odds && Number.isFinite(oddsMs) && oddsMs <= serverNow + 1000 &&
    serverNow - oddsMs <= 14000 && oddsMs >= (round?.startMs ?? Infinity) &&
    isWaterxMarketSource(odds.source) &&
    [odds.up, odds.down].every(v => Number.isFinite(v) && v >= 0 && v <= 1) &&
    [odds.upPriceCents, odds.downPriceCents].every(v => Number.isFinite(v) && v >= 0 && v <= 100);
  const intervalMismatch = payload?.intervalMinutes !== interval;
  const oddsMismatch = !!odds && !isWaterxMarketSource(odds.source);
  const marketCurrent = roundCurrent && oddsFresh && !intervalMismatch && !oddsMismatch;
  const remaining = round ? timeRemaining(round.expiryMs, serverNow) : "—";
  const priceDelta = roundCurrent && comparisonFresh && round && comparisonMs >= round.startMs ? comparison!.price - round.referencePrice : null;
  const priceDeltaPct = priceDelta != null && round?.referencePrice ? priceDelta / round.referencePrice * 100 : null;
  const chartPayload = chart.loadedUrl === chartUrl ? chart.data : null;
  const archiveMatches = isCoinbaseSource(chartPayload?.source);
  const acceptedPoints = (archiveMatches ? chartPayload?.points ?? [] : []).map(p => ({ ...p, at: typeof p.at === "string" ? Date.parse(p.at) : p.at }))
    .filter(p => Number.isFinite(p.at) && (p.price == null || (Number.isFinite(p.price) && p.price > 0)));
  const [stream, setStream] = useState<Point[]>([]);
  const [streamStatus, setStreamStatus] = useState<"CONNECTING" | "LIVE" | "RECONNECTING">("CONNECTING");
  const streamRef = useRef<EventSource | null>(null);
  const streamCursor = useRef("");
  const pendingPaint = useRef<{ id: string; receivedAt: number } | null>(null);
  useEffect(() => {
    let disposed = false, retry: number | undefined, wait = 1000;
    const markFeedGap = (reason: string) => {
      const at = Date.now();
      setStream(old => {
        const last = old.at(-1);
        if (last?.gap && Math.abs(Number(last.at) - at) < 14000) return old;
        return [...old, { at, price: null, gap: true, reason, source: "Coinbase" }].slice(-700);
      });
    };
    const connect = () => {
      if (disposed || document.visibilityState === "hidden") return;
      setStreamStatus("CONNECTING");
      const es = new EventSource(sseReconnectUrl("/api/chart/stream", streamCursor.current)); streamRef.current = es;
      es.onopen = () => { if (!disposed) { setStreamStatus("LIVE"); wait = 1000; } };
      const receive = (ev: Event) => {
        const e = ev as MessageEvent<string>; let body: Record<string, unknown> = {};
        if (e.lastEventId) {
          const previous = streamCursor.current;
          if (previous && /^\d+$/.test(previous) && /^\d+$/.test(e.lastEventId) && Number(e.lastEventId) > Number(previous) + 1) {
            markFeedGap(`Stream event sequence gap: ${previous} to ${e.lastEventId}.`);
          }
          streamCursor.current = e.lastEventId;
        }
        try { body = JSON.parse(e.data) as Record<string, unknown>; } catch { /* malformed event is represented as a gap */ }
        const rawAt = body.sourceAt ?? body.serverEventAt ?? body.at;
        const at = typeof rawAt === "number" ? rawAt : typeof rawAt === "string" ? Date.parse(rawAt) : Date.now();
        const eventSource = typeof body.source === "string" ? body.source : "Coinbase";
        const sourceMismatch = !isCoinbaseSource(eventSource);
        const gap = e.type === "gap" || body.gap === true || sourceMismatch || typeof body.price !== "number" || !Number.isFinite(body.price);
        const p: Point = { at, sourceAt: rawAt as string | number | null, eventId: e.lastEventId || (typeof body.eventId === "string" || typeof body.eventId === "number" ? body.eventId : undefined), price: gap ? null : body.price as number, gap, source: eventSource, reason: sourceMismatch ? "Unexpected comparison source." : typeof body.reason === "string" ? body.reason : undefined };
        if (!gap && p.eventId != null)
          pendingPaint.current = { id: String(p.eventId), receivedAt: performance.now() };
        setStream(old => [...old, p].slice(-700));
      };
      es.addEventListener("tick", receive); es.addEventListener("gap", receive);
      es.addEventListener("reset", event => {
        const resetCursor = (event as MessageEvent<string>).lastEventId;
        // A new process starts event IDs over. Keeping the old cursor causes an
        // endless reset loop; zero is a valid restart cursor.
        streamCursor.current = resetSseCursor(resetCursor);
        markFeedGap("SSE replay reset; comparison continuity is interrupted.");
        chart.reload();
        setStreamStatus("RECONNECTING");
        es.close();
        retry = window.setTimeout(connect, 150);
      });
      es.onerror = () => { es.close(); if (!disposed) { markFeedGap("Coinbase comparison stream disconnected."); setStreamStatus("RECONNECTING"); retry = window.setTimeout(connect, wait); wait = Math.min(wait * 2, 15000); } };
    };
    connect();
    const onVisible = () => { if (document.visibilityState === "visible" && streamRef.current?.readyState === EventSource.CLOSED) connect(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; if (retry) clearTimeout(retry); streamRef.current?.close(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  useEffect(() => {
    const pending = pendingPaint.current;
    if (!pending || String(stream.at(-1)?.eventId ?? "") !== pending.id) return;
    const frame = requestAnimationFrame(() => {
      if (pendingPaint.current !== pending) return;
      recordBrowserRender(pending.receivedAt, performance.now());
      pendingPaint.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [stream]);
  const merged = useMemo(() => {
    return insertTimestampGaps(
      mergeComparisonPoints(
        acceptedPoints.map(point => ({ ...point, at: Number(point.at) })),
        stream.map(point => ({ ...point, at: Number(point.at) })),
      ).filter(point => Number(point.at) >= Date.now() - 15 * 60_000),
      14_000,
    );
  }, [acceptedPoints, stream]);

  const refreshAll = () => { live.reload(); chart.reload(); };
  return <div className="page live-page">
    <PageTitle index="01" title="Live round desk"><div className="heading-right"><span className="sync-label"><i />{live.error && live.errorUrl === liveUrl ? "SYNC DELAYED" : "AUTO-REFRESH · 3 SEC"}</span><IntervalSwitch value={interval} onChange={setInterval} /></div></PageTitle>
    {live.error && live.errorUrl === liveUrl && payload == null ? <ErrorBox message={live.error} retry={live.reload} /> : live.loading && !payload ? <Skeleton height={420} /> : <>
      <section className="round-banner">
        <div className="round-banner-copy"><span className="market-kicker"><span className="round-glyph">W</span> WATERX MARKET <span className="slash">/</span> BTC · UP OR DOWN · {interval} MIN</span>
          <h2>Bitcoin round <em>· {interval}m</em></h2>
          <p>Market snapshot and independent live comparison.</p>
        </div>
        <div className="round-identity"><span>ACTIVE ROUND</span><strong title={roundCurrent ? round?.id : undefined}>{roundCurrent ? round?.id : "Not verified"}</strong></div>
      </section>
      <div className="metric-ribbon">
        <div className="anchor-metric"><span className="metric-label">PRICE TO BEAT <b>· WATERX</b></span><strong>{roundCurrent ? fmtUsd(round?.referencePrice) : "—"}</strong><small>{roundCurrent ? <>{round?.anchorConfirmed ? "Reference confirmed" : "Confirmation pending"} · {ago(payload?.serverTime)}</> : "No verified active-round threshold"}</small></div>
        <div className="comparison-metric"><span className="metric-label">LIVE COMPARISON <b>· COINBASE</b></span><strong className={comparisonFresh && priceDelta != null ? priceDelta >= 0 ? "gain" : "loss" : comparisonFresh ? "comparison-live" : "dim"}>{comparisonFresh ? fmtUsd(comparison?.price) : "—"}</strong><small>{comparisonFresh ? ago(comparison?.asOf) : "No fresh comparison quote"}</small></div>
        <div className="delta-metric"><span className="metric-label">DISTANCE TO REFERENCE</span><strong className={priceDelta == null ? "dim" : priceDelta >= 0 ? "gain" : "loss"}>{priceDelta == null ? "—" : `${priceDelta >= 0 ? "+" : "−"}${fmtUsd(Math.abs(priceDelta))}`}</strong><small>{priceDeltaPct == null ? "Waiting for matched quotes" : `${priceDeltaPct >= 0 ? "+" : "−"}${Math.abs(priceDeltaPct).toFixed(3)}% from reference`}</small></div>
        <div className="round-count"><span>ROUND CLOSES IN</span><strong>{roundCurrent && round ? remaining : "—:—"}</strong><small>{roundCurrent ? round?.phase || "ROUND IN PROGRESS" : "ROUND STATUS UNAVAILABLE"}</small></div>
      </div>
       <div className={`reliability-strip ${!roundCurrent || (round && !round.anchorConfirmed) ? "caution" : ""}`}>
         <ShieldCheck size={15} />
         <span><b>{!roundCurrent ? "Round not verified." : round?.anchorConfirmed ? "Read-only observation." : "Reference confirmation pending."}</b> {!roundCurrent ? "Live values are withheld until the matching WaterX round is fresh." : `WaterX supplies the beginning reference; ${SETTLEMENT_SOURCE_LABEL.toLowerCase()} determines settlement. Coinbase is comparison only.`}</span>
       </div>
      <section className="chart-panel">
        <div className="section-head chart-head"><div><div className="eyebrow">INDEPENDENT OBSERVATION · COINBASE</div><h2>BTC price trace</h2><p>Live and archived comparison, shown against the WaterX beginning reference.</p></div><span className={`feed-pill ${streamStatus.toLowerCase()}`}><i />{streamStatus}</span></div>
        {chart.error && chart.errorUrl === chartUrl && !chartPayload && !merged.length ? <ErrorBox message={chart.error} retry={chart.reload} /> : chart.loading && !chartPayload && !merged.length ? <Skeleton height={330} /> :
          <PriceChart points={merged} interval={interval} anchor={roundCurrent ? round?.referencePrice ?? null : null} streamStatus={streamStatus} round={roundCurrent ? round : null} archiveWindow={chartPayload?.windowMinutes} coveragePartial={chartPayload?.coverage?.partial === true} windowMode={chartWindow} onWindowChange={setChartWindow} />}
        {chart.error && chart.errorUrl === chartUrl && <div className="reference-absent">Archive refresh failed. Live Coinbase observations remain visible where available. <button className="text-button" onClick={chart.reload}>Retry archive</button></div>}
        {chartPayload?.coverage?.partial && <div className="gap-caption">Partial archive coverage{chartPayload.coverage.percent != null ? ` · ${chartPayload.coverage.percent}% reported` : ""}{chartPayload.coverage.reason ? ` · ${chartPayload.coverage.reason}` : ""}. Unobserved periods remain blank.</div>}
        {chartPayload && !archiveMatches && <div className="gap-caption">Archive source mismatch: historical points withheld; expected Coinbase comparison data.</div>}
        <div className="legend-row"><span><i className="legend-price" /> Coinbase observations</span><span><i className="legend-anchor" /> WaterX price to beat</span><span className="legend-stamp">Archive: {chartPayload?.source || "not reported"} · stream: Coinbase</span></div>
        <div className="chart-foot"><span>{merged.length.toLocaleString()} retained samples · {chartPayload?.windowMinutes ?? interval}m archive + live stream</span><button className="text-button" onClick={chart.reload}><RefreshCw size={13} /> Refresh archive</button></div>
      </section>
      <section className="lower-grid">
        <div className="odds-panel">
          <div className="section-head"><div><div className="eyebrow">WATERX MARKET SNAPSHOT</div><h2>Round probabilities</h2></div><span className="quote-dot">{marketCurrent ? "CURRENT" : "WITHHELD"}</span></div>
          <p className="odds-intro">Market-implied odds from WaterX. These are not BluewaterAI forecasts.</p>
            {marketCurrent && odds ? <div className="odds-content">
            <div className="odds-row up-row"><span><ArrowUpRight size={16} /> UP <small>settles up at equality</small></span><b>{fmtProbability(odds.up)} <small>{fmtOdds(odds.upPriceCents)}</small></b></div>
            <div className="odds-row down-row"><span><ArrowDownRight size={16} /> DOWN</span><b>{fmtProbability(odds.down)} <small>{fmtOdds(odds.downPriceCents)}</small></b></div>
            <div className="indicative-sizing"><label htmlFor="indicative-amount">$ indicative amount · one side</label><div><span>$</span><input id="indicative-amount" aria-label="Indicative amount in dollars" type="number" min="0.01" step="0.01" value={indicativeAmount} onChange={e => setIndicativeAmount(e.target.value)} /></div></div>
            <div className="indicative-return"><span>Per-side gross · not profit or quote<small>Same amount, each side shown separately · fees, gas and net unknown</small></span><strong>{fmtUsd(indicativeGross(Number(indicativeAmount), odds.upPriceCents))} <small>UP</small><i>/</i>{fmtUsd(indicativeGross(Number(indicativeAmount), odds.downPriceCents))} <small>DOWN</small></strong></div>
            <p className="source-note">Source: {odds.source} · as of {utc(odds.asOf)} · indicative arithmetic only. Not a net payout.</p>
            </div> : <div className="withheld-block"><ShieldCheck size={20} /><strong>Market odds hidden</strong><span>{intervalMismatch || oddsMismatch ? "WaterX market source or interval did not match this view." : "A fresh odds quote for the active round is not available."} No values are carried forward.</span></div>}
        </div>
        <div className="decision-panel">
          <div className="section-head"><div><div className="eyebrow">BLUEWATER POLICY</div><h2>Desk decision</h2></div><span className="hold-badge">{snapshotCurrent && payload?.decision?.action === "HOLD" ? "HOLD" : "WITHHELD"}</span></div>
          <div className="decision-copy"><span className="hold-mark">—</span><div><strong>{snapshotCurrent && payload?.decision?.action === "HOLD" ? "No action qualified" : "No advisory shown"}</strong><p>{snapshotCurrent && payload?.decision?.action === "HOLD" ? payload?.decision?.reason || payload?.reason || "The service reports HOLD for this round." : snapshotCurrent ? "The current service response does not report a verified HOLD state. No advisory is displayed." : "Live snapshot stale or unavailable. No action is qualified."}</p></div></div>
        </div>
      </section>
      <details className="method-card"><summary><span><CircleHelp size={15} /> How this market resolves</span><ChevronDown size={15} /></summary><p>The price to beat is the beginning reference reported by WaterX. Settlement uses the official Chainlink BTC/USD time-weighted average price (TWAP), compared with that beginning reference; Up wins at equality. Coinbase is shown only as a live comparison and is never used for settlement.</p></details>
      <div className="live-bottom"><span>{snapshotCurrent ? `Snapshot as of ${utc(payload?.serverTime)}` : payload ? `Last response · stale · ${utc(payload.serverTime)}` : "No current live snapshot"}</span><button className="quiet-button" onClick={refreshAll}><RefreshCw size={14} /> Refresh desk</button><Link href="/health" className="inline-link">Inspect data health <ExternalLink size={13} /></Link></div>
    </>}
  </div>;
}

function PriceChart({ points, interval, anchor, streamStatus, round, archiveWindow, coveragePartial, windowMode, onWindowChange }: { points: Point[]; interval: Interval; anchor: number | null; streamStatus: string; round: LivePayload["round"]; archiveWindow?: number; coveragePartial: boolean; windowMode: "round" | 5 | 15; onWindowChange: (mode: "round" | 5 | 15) => void }) {
  const measureRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(320, Math.round(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const H = 330, left = 72, right = Math.min(136, Math.max(104, width * .24)), top = 24, bottom = 39;
  const plotRight = width - right;
  const pointTimes = points.map(p => Number(p.at)).filter(Number.isFinite);
  const latestTime = Math.max(Date.now(), ...pointTimes);
  const activeWindowMode = windowMode === "round" && !round ? interval : windowMode;
  const windowMinutes: Interval = activeWindowMode === "round" ? interval : activeWindowMode;
  const duration = activeWindowMode === "round" && round ? round.expiryMs - round.startMs : windowMinutes * 60_000;
  const start = activeWindowMode === "round" && round ? round.startMs : latestTime - duration;
  const end = activeWindowMode === "round" && round ? round.expiryMs : latestTime;
  const visible = points.filter(p => Number(p.at) >= start && Number(p.at) <= end + 3000);
  const samples = visible.filter(p => p.price != null && !p.gap && Number.isFinite(Number(p.at)));
  const latest = samples.at(-1) ?? null;
  const active = selectedKey == null ? null : samples.find(p => inspectedPointKey(p) === selectedKey) ?? null;
  const values = [...samples.map(p => p.price as number), ...(anchor != null ? [anchor] : [])];
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  const pad = Math.max((max - min) * .15, Math.abs(anchor ?? max) * .00008, 1);
  const lo = min - pad, hi = max + pad;
  const x = (t: number) => left + ((t - start) / Math.max(1, end - start)) * (plotRight - left);
  const y = (p: number) => top + ((hi - p) / Math.max(1, hi - lo)) * (H - top - bottom);
  const chunks: Point[][] = [];
  let chunk: Point[] = [];
  visible.forEach(p => {
    if (p.price == null || p.gap) { if (chunk.length) chunks.push(chunk); chunk = []; }
    else chunk.push(p);
  });
  if (chunk.length) chunks.push(chunk);
  const tone = anchor == null || latest?.price == null ? "neutral" : latest.price >= anchor ? "positive" : "negative";
  const selectAt = (clientX: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || !samples.length) return;
    const t = pointerTimestamp(clientX, bounds.left, bounds.width, left / width, plotRight / width, start, end);
    if (t == null) return;
    let nearest = samples[0];
    for (const sample of samples) if (Math.abs(Number(sample.at) - t) < Math.abs(Number(nearest.at) - t)) nearest = sample;
    setSelectedKey(inspectedPointKey(nearest));
  };
  const partialWindow = coveragePartial || (activeWindowMode !== "round" && archiveWindow != null && activeWindowMode > archiveWindow);
  const startInside = !!round && round.startMs >= start && round.startMs <= end;
  const endInside = !!round && round.expiryMs >= start && round.expiryMs <= end;
  return <div ref={measureRef} className="chart-wrap">
    <div className="chart-controls" role="group" aria-label="Chart time window">
      {(["round", 5, 15] as const).map(mode => <button key={mode} className={activeWindowMode === mode ? "active" : ""} aria-pressed={activeWindowMode === mode} disabled={mode === "round" && !round} onClick={() => { onWindowChange(mode); setSelectedKey(null); }}>{mode === "round" ? "This round" : `${mode} min`}</button>)}
      <span>{activeWindowMode === "round" ? "Fixed round" : "Rolling archive"} · {visible.length} observations{partialWindow ? " · partial" : ""}</span>
      {active && <button className="return-live" onClick={() => setSelectedKey(null)}>Return to live</button>}
    </div>
    {samples.length ? <div className="chart-measure">
      <svg ref={svgRef} className={`price-chart ${tone}`} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`Coinbase BTC comparison observations over ${activeWindowMode === "round" ? "the current round" : `${activeWindowMode} minutes`}; dashed line is the WaterX reported reference`}>
        <defs><linearGradient id="price-underlay" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" className="area-start" stopOpacity=".22" /><stop offset="100%" className="area-start" stopOpacity="0" /></linearGradient></defs>
        {[0, .5, 1].map((f, i) => { const py = top + f * (H - top - bottom); const price = hi - f * (hi - lo); return <g key={i}><line x1={left} x2={plotRight} y1={py} y2={py} className="gridline" /><text x={left - 10} y={py + 3} textAnchor="end" className="axis-label">{fmtUsd(price)}</text></g>; })}
        {anchor != null && <><line x1={left} x2={plotRight} y1={y(anchor)} y2={y(anchor)} className="anchor-line" /><text x={plotRight + 8} y={y(anchor) + 3} className="anchor-label">REFERENCE</text></>}
        {chunks.map((segment, idx) => <g key={idx}>
          {segment.length > 1 && <polygon points={`${x(Number(segment[0].at))},${H - bottom} ${segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} ${x(Number(segment.at(-1)!.at))},${H - bottom}`} className="price-area" />}
          {segment.length > 1 && <polyline points={segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} className="price-line" />}
        </g>)}
        {latest?.price != null && <g><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="9" className="latest-halo" /><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="4" className="latest-dot" /><text x={plotRight + 8} y={Math.max(top + 7, Math.min(H - bottom - 5, y(latest.price) + 4))} className="latest-label">{fmtUsd(latest.price)}</text></g>}
        {active?.price != null && <g><line x1={x(Number(active.at))} x2={x(Number(active.at))} y1={top} y2={H - bottom} className="inspect-line" /><circle cx={x(Number(active.at))} cy={y(active.price)} r="5" className="inspect-point" /></g>}
        {startInside && <><line x1={x(round!.startMs)} x2={x(round!.startMs)} y1={top} y2={H - bottom} className="round-boundary" /><text x={x(round!.startMs) + 4} y={H - 8} className="boundary-label">START</text></>}
        {endInside && <><line x1={x(round!.expiryMs)} x2={x(round!.expiryMs)} y1={top} y2={H - bottom} className="round-boundary" /><text x={x(round!.expiryMs) - 4} y={H - 8} textAnchor="end" className="boundary-label">CLOSE</text></>}
        <text x={left} y={H - 8} className="axis-label">{new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" })} UTC</text><text x={plotRight} y={H - 8} textAnchor="end" className="axis-label">{new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" })} UTC</text>
        <rect x={left} y={top} width={plotRight - left} height={H - top - bottom} className="chart-hit" tabIndex={0} aria-label="Inspect chart observations with arrow keys" onPointerMove={e => selectAt(e.clientX)} onPointerDown={e => { if (e.pointerType === "touch") selectAt(e.clientX); }} onClick={e => selectAt(e.clientX)} onKeyDown={e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const index = active ? samples.findIndex(p => inspectedPointKey(p) === selectedKey) : samples.length - 1; const next = Math.min(samples.length - 1, Math.max(0, index + (e.key === "ArrowRight" ? 1 : -1))); setSelectedKey(inspectedPointKey(samples[next])); } }} />
      </svg>
    </div> : <div className="chart-empty"><Activity size={22} /><strong>No comparison samples in this window</strong><span>Waiting for archived points or a live Coinbase event. Missing observations are not interpolated.</span></div>}
    {active && <div className="sample-inspector" aria-live="polite"><span>INSPECTED OBSERVATION</span><b>{fmtUsd(active.price)}</b><small>{utc(Number(active.at))} · {active.source || "Coinbase"} · event age {ago(active.sourceAt ?? Number(active.at))}</small></div>}
    {points.some(p => p.gap || p.price == null) && <div className="gap-caption">Feed gaps remain blank; no price is inferred. {streamStatus !== "LIVE" && "Live feed reconnecting."}</div>}
  </div>;
}

function HistoryPage() {
  const [interval, setInterval] = useIntervalPreference();
  const url = `/api/waterx/history?interval=${interval}`;
  const result = useApi<{ rows?: Record<string, unknown>[] }>(url, 30000);
  const intervalResponseReady = result.loadedUrl === url;
  const rows = intervalResponseReady ? result.data?.rows ?? [] : [];
  return <div className="page inner-page">
    <PageTitle index="02" title="Round history"><div className="heading-right"><span className="muted-label">MARKET DURATION</span><IntervalSwitch value={interval} onChange={setInterval} /></div></PageTitle>
    <div className="intro-line"><p>Recorded WaterX rounds and their reported reference prices. Each interval is a different market duration.</p><span>{rows.length} rows returned</span></div>
    {result.error && result.errorUrl === url ? <ErrorBox message={result.error} retry={result.reload} /> : !intervalResponseReady ? <Skeleton height={330} /> :
      rows.length ? <div className="table-frame"><table><thead><tr><th>Round</th><th>Start · UTC</th><th>Close · UTC</th><th>Price to beat</th><th>Settlement</th><th>Outcome</th><th>Evidence</th><th>Market UP at capture</th></tr></thead><tbody>{rows.map((r, i) => {
        const id = String(r.roundId ?? `round-${i}`);
        const started = r.startMs;
        const ended = r.expiryMs;
        const anchor = typeof r.anchorPrice === "number" ? r.anchorPrice : null;
        return <tr key={id}><td className="mono-cell" title={id}>{id.slice(0, 8)}…</td><td>{utc(typeof started === "number" ? started : undefined)}</td><td>{utc(typeof ended === "number" ? ended : undefined)}</td><td>{fmtUsd(anchor)}{r.anchorConfirmed !== true && <small> · pending confirmation</small>}</td><td>{fmtUsd(typeof r.settlePrice === "number" ? r.settlePrice : null)}</td><td><span className={`outcome ${String(r.outcome ?? "").toLowerCase()}`}>{String(r.outcome ?? "Unresolved")}</span></td><td title={typeof r.withheldReason === "string" ? r.withheldReason : undefined}>{String(r.labelStatus ?? "unresolved")}</td><td>{typeof r.probabilityUp === "number" ? `${(r.probabilityUp * 100).toFixed(1)}%` : "Not captured"}</td></tr>;
      })}</tbody></table></div> : <div className="empty-state"><Clock3 size={22} /><strong>No recorded rounds returned</strong><span>History is shown only when the WaterX archive has recorded rows. No examples are fabricated.</span></div>}
    <div className="history-note"><ShieldCheck size={15} /> These are observed records, not a performance claim or trading recommendation.</div>
  </div>;
}

function LearningPage() {
  const [interval, setInterval] = useIntervalPreference();
  const url = `/api/waterx/model?interval=${interval}`;
  const result = useApi<Record<string, unknown>>(url, 60000);
  const intervalResponseReady = result.loadedUrl === url;
  const data = intervalResponseReady ? result.data ?? {} : {};
  const readiness = data.readiness && typeof data.readiness === "object" ? data.readiness as Record<string, unknown> : {};
  const split = data.split && typeof data.split === "object" ? data.split as Record<string, unknown> : {};
  const asRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const metricValue = (record: Record<string, unknown> | null, keys: string[]) => {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  };
  const metricCount = (record: Record<string, unknown> | null) => metricValue(record, ["count", "sampleCount", "evaluatedCount", "roundCount"]);
  const fmtMetric = (value: number | null) => value == null ? "Not scored" : value.toFixed(4);
  const readinessNumber = (key: string) => typeof readiness[key] === "number" && Number.isFinite(readiness[key]) ? readiness[key] as number : null;
  const training = asRecord(data.trainingMetrics);
  const testing = asRecord(data.testMetrics);
  const candidate = asRecord(data.candidateTraining);
  const candidateTest = asRecord(candidate?.candidateTestMetrics);
  const candidateMarket = asRecord(candidate?.matchingMarketTestMetrics);
  const trainingBrier = metricValue(training, ["brier", "brierScore", "brier_score"]);
  const trainingLogLoss = metricValue(training, ["logLoss", "logloss", "log_loss"]);
  const testBrier = metricValue(testing, ["brier", "brierScore", "brier_score"]);
  const testLogLoss = metricValue(testing, ["logLoss", "logloss", "log_loss"]);
  const eligible = readinessNumber("eligibleRounds");
  const minimumEligible = readinessNumber("minimumEligibleRounds");
  const span = readinessNumber("spanHours");
  const minimumSpan = readinessNumber("minimumSpanHours");
  const coverage = readinessNumber("cadenceCoveragePercent");
  const minimumCoverage = readinessNumber("minimumCoveragePercent");
  const status = typeof data.status === "string" ? data.status : "unavailable";
  const ready = readiness.ready === true;
  const metricUnavailableReason = !ready
    ? "Not scored: this interval has not met the sample, span, and coverage readiness gates."
    : "Not scored: the service has not returned a verified metric result.";
  return <div className="page inner-page">
    <PageTitle index="03" title="Learning evidence"><div className="heading-right"><span className="muted-label">MARKET DURATION</span><IntervalSwitch value={interval} onChange={setInterval} /></div></PageTitle>
    <div className="learning-lede"><BookOpen size={19} /><p>Evidence is assessed separately for each WaterX market duration. WaterX odds are market probabilities, not a BluewaterAI forecast. Only verified settlement labels enter evaluation.</p></div>
    {result.error && result.errorUrl === url ? <ErrorBox message={result.error} retry={result.reload} /> : !intervalResponseReady ? <Skeleton height={360} /> : <>
      <section className={`learning-status ${ready ? "ready" : "not-ready"}`}>
        <div><span className="eyebrow">{interval}-MINUTE MARKET COHORT</span><strong>{ready ? "Readiness gates met" : status === "insufficient" ? "More verified history needed" : status.replace(/[_-]/g, " ")}</strong>
          <p>{ready ? "Eligibility gates are met for this interval. Metrics below appear only when the service has actually scored them." : `Readiness is interval-specific. This ${interval}-minute cohort is not currently eligible for a promoted forecast.`}</p>
        </div><span className={`readiness-badge ${ready ? "pass" : ""}`}>{ready ? "READY" : "BUILDING EVIDENCE"}</span>
      </section>

      <section className="readiness-panel">
        <div className="learning-section-heading"><div><div className="eyebrow">COHORT READINESS</div><h2>Evidence gates</h2></div><span>{interval}m rounds</span></div>
        <div className="readiness-grid">
          <article><span>ELIGIBLE ROUNDS</span><strong>{eligible == null ? "Unavailable" : `${eligible} / ${minimumEligible ?? "—"}`}</strong><small>Resolved, verified labels admitted to this cohort</small></article>
          <article><span>OBSERVED SPAN</span><strong>{span == null ? "Unavailable" : `${span.toFixed(1)} / ${minimumSpan ?? "—"} h`}</strong><small>Elapsed history in the selected interval</small></article>
          <article><span>CADENCE COVERAGE</span><strong>{coverage == null ? "Unavailable" : `${coverage.toFixed(1)} / ${minimumCoverage ?? "—"}%`}</strong><small>Observed cadence against the service threshold</small></article>
          <article><span>MAXIMUM GAP</span><strong>{readinessNumber("maximumGapMinutes") == null ? "Unavailable" : `${readinessNumber("maximumGapMinutes")!.toFixed(1)} min`}</strong><small>Allowed gap: {readinessNumber("maximumAllowedGapMinutes") == null ? "not reported" : `${readinessNumber("maximumAllowedGapMinutes")} min`}</small></article>
        </div>
        <div className="cohort-outcome"><span className={`cohort-dot ${ready ? "pass" : ""}`} /><p>{ready ? "Readiness is true for this cohort; it does not by itself establish predictive skill." : `Not ready: ${eligible ?? "Unavailable"} eligible of ${minimumEligible ?? "an unreported minimum"} rounds, ${span == null ? "span unavailable" : `${span.toFixed(1)} hours observed`}, and ${coverage == null ? "coverage unavailable" : `${coverage.toFixed(1)}% cadence coverage`}.`}</p></div>
        <div className="label-integrity"><span>{typeof data.evidenceCount === "number" ? data.evidenceCount : "—"} evidence observations</span><span>{typeof data.withheldLabels === "number" ? data.withheldLabels : "—"} labels withheld</span><p>Eligible-round counts are stricter than raw observations. Unresolved or unverified settlements are excluded from scoring, not treated as outcomes.</p></div>
      </section>

      <section className="split-panel">
        <div className="learning-section-heading"><div><div className="eyebrow">CHRONOLOGICAL EVALUATION</div><h2>Training and test split</h2></div><span className="split-method">{typeof split.method === "string" ? split.method : "Split details unavailable"}</span></div>
        <div className="split-counts">
          <div><span>TRAINING ROUNDS</span><strong>{typeof split.trainingCount === "number" ? split.trainingCount : "—"}</strong></div>
          <div><span>EMBARGO EXCLUDED</span><strong>{typeof split.embargoExcludedCount === "number" ? split.embargoExcludedCount : "—"}</strong></div>
          <div><span>TEST ROUNDS</span><strong>{typeof split.testCount === "number" ? split.testCount : "—"}</strong></div>
        </div>
        {typeof data.baseline === "string" && <div className="baseline-note"><span>BASELINE UNDER EVALUATION</span><p>{data.baseline}</p></div>}
      </section>

      <section className="metric-results">
        {([
          { label: "TRAINING METRICS", record: training, brier: trainingBrier, loss: trainingLogLoss },
          { label: "HELD-OUT TEST METRICS", record: testing, brier: testBrier, loss: testLogLoss },
        ]).map(metric => <article key={metric.label} className="metric-result">
          <div className="eyebrow">{metric.label}</div>
          {metric.record && (metric.brier != null || metric.loss != null) ? <>
            <div className="score-grid"><div><span>BRIER SCORE</span><strong>{fmtMetric(metric.brier)}</strong></div><div><span>LOG LOSS</span><strong>{fmtMetric(metric.loss)}</strong></div></div>
            <p>{metricCount(metric.record) == null ? "Evaluation count not reported." : `${metricCount(metric.record)} scored observations.`} Lower scores are better; metrics are shown only as returned by the service.</p>
          </> : <div className="metric-unscored"><strong>Not scored</strong><p>{metricUnavailableReason} No score is inferred from the evidence count.</p></div>}
        </article>)}
      </section>

      <section className="readiness-panel">
        <div className="learning-section-heading"><div><div className="eyebrow">OFFLINE SHADOW CANDIDATE</div><h2>Not a serving forecast</h2></div><span>{typeof candidate?.status === "string" ? candidate.status.replace(/-/g, " ") : "unavailable"}</span></div>
        <div className="readiness-grid">
          <article><span>PROSPECTIVE SNAPSHOTS</span><strong>{typeof candidate?.recordCount === "number" ? candidate.recordCount : "—"}</strong><small>Frozen features only; no backfilled odds</small></article>
          <article><span>ACCEPTED LABELS</span><strong>{typeof candidate?.acceptedLabelCount === "number" ? candidate.acceptedLabelCount : "—"}</strong><small>Disputed settlements excluded</small></article>
          <article><span>CANDIDATE TEST BRIER</span><strong>{fmtMetric(metricValue(candidateTest, ["brier"]))}</strong><small>Untouched interval-specific test rounds</small></article>
          <article><span>SAME-ROUND MARKET BRIER</span><strong>{fmtMetric(metricValue(candidateMarket, ["brier"]))}</strong><small>Comparison baseline, not a fill quote</small></article>
        </div>
        <div className="cohort-outcome"><span className="cohort-dot" /><p>{typeof candidate?.rejectionReason === "string" ? candidate.rejectionReason : typeof candidate?.reason === "string" ? candidate.reason : "No qualified candidate result is available."} No candidate is promoted or used by the live desk.</p></div>
      </section>

      <section className="model-disposition">
        <div className="disposition-mark"><ShieldCheck size={19} /></div>
        <div><span className="eyebrow">MODEL STATUS</span><h2>No promoted forecast</h2>
          <p>{data.promotedForecast == null ? "The service reports no promoted model for this interval. The learning baseline is observational and is not an actionable prediction." : "A forecast object is present, but this page does not convert it into a recommendation."}</p>
          <p className="action-status">{data.action == null ? "No action qualified." : `Reported action: ${String(data.action)}`}</p>
        </div>
      </section>
      <details className="label-policy"><summary><span><CircleHelp size={15} /> How labels are admitted</span><ChevronDown size={15} /></summary>
        <p>{typeof data.labelPolicy === "string" ? data.labelPolicy : "Labels require verified WaterX settlement data. Unresolved or unconfirmed rounds are not treated as wins or losses."}</p>
        <div className="label-counts"><span>Evidence observations <b>{typeof data.evidenceCount === "number" ? data.evidenceCount : "Not reported"}</b></span><span>Withheld labels <b>{typeof data.withheldLabels === "number" ? data.withheldLabels : "Not reported"}</b></span></div>
      </details>
      <div className="learning-foot"><ShieldCheck size={15} /> An insufficient cohort is not a negative performance result. Until evidence qualifies and a forecast is promoted, the live desk remains HOLD.</div>
    </>}
  </div>;
}

function HealthPage() {
  const [interval, setInterval] = useIntervalPreference();
  const liveUrl = `/api/waterx/live?interval=${interval}`;
  const chartUrl = `/api/waterx/chart?interval=${interval}`;
  const versionUrl = "/api/waterx/version";
  const collectorUrl = `/api/waterx/health?interval=${interval}`;
  const latencyUrl = `/api/waterx/latency?interval=${interval}`;
  const live = useApi<LivePayload>(liveUrl, 5000);
  const chart = useApi<ChartPayload>(chartUrl, 30000);
  const version = useApi<Record<string, unknown>>(versionUrl, 60000);
  const collector = useApi<Record<string, unknown>>(collectorUrl, 15000);
  const latency = useApi<Record<string, unknown>>(latencyUrl, 30000);
  const versionInfo = !version.error && version.loadedUrl === versionUrl ? version.data : null;
  const collectorInfo = !collector.error && collector.loadedUrl === collectorUrl ? collector.data : null;
  const versionBuild = versionInfo?.build && typeof versionInfo.build === "object" ? versionInfo.build as Record<string, unknown> : {};
  const versionSource = versionInfo?.source && typeof versionInfo.source === "object" ? versionInfo.source as Record<string, unknown> : {};
  const versionModel = versionInfo?.model && typeof versionInfo.model === "object" ? versionInfo.model as Record<string, unknown> : {};
  const collectorDetails = collectorInfo?.collector && typeof collectorInfo.collector === "object" ? collectorInfo.collector as Record<string, unknown> : {};
  const collectorIntervals = collectorInfo?.backlogByInterval && typeof collectorInfo.backlogByInterval === "object"
    ? collectorInfo.backlogByInterval as Record<string, unknown> : {};
  const latencyInfo = !latency.error && latency.loadedUrl === latencyUrl ? latency.data : null;
  const latencyContainer = latencyInfo?.stages ?? latencyInfo?.metrics ?? latencyInfo?.latencies ?? latencyInfo;
  const latencyRecord = latencyContainer && typeof latencyContainer === "object" && !Array.isArray(latencyContainer)
    ? latencyContainer as Record<string, unknown> : {};
  const latencyList = Array.isArray(latencyContainer) ? latencyContainer.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : [];
  const latencyStage = (aliases: string[]) => {
    const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/latency/g, "").replace(/ms$/, "");
    const wanted = new Set(aliases.map(normalize));
    const entry = latencyList.find(item => {
      const name = item.stage ?? item.name ?? item.key;
      return typeof name === "string" && wanted.has(normalize(name));
    }) ?? Object.entries(latencyRecord).find(([key]) => wanted.has(normalize(key)))?.[1];
    return entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
  };
  const latencyNumber = (stage: Record<string, unknown> | null, key: "p50" | "p95" | "p99") => {
    const value = stage?.[`${key}Ms`] ?? stage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms` : "—";
  };
  const latencyStages = [
    { label: "Coinbase source → server", aliases: ["comparisonSourceToServer"] },
    { label: "Coinbase server → publish", aliases: ["comparisonServerToPublish"] },
    { label: "Round start → observation", aliases: ["roundStartToObservation", "round_start_observation", "round-start-observation", "round_start_to_observation"] },
    { label: "WaterX settlement → label", aliases: ["providerSettlementToAcceptedLabel"] },
  ];
  const liveMatchesInterval = live.loadedUrl === liveUrl;
  const snapshot = liveMatchesInterval ? live.data : null;
  const snapshotToleranceMs = interval === 5 ? 16_000 : 31_000;
  const serverMs = snapshot?.serverTime ? Date.parse(snapshot.serverTime) : NaN;
  const serverNow = Number.isFinite(serverMs) ? Date.now() + (serverMs - live.updated) : Date.now();
  const snapshotCurrent = !live.error && liveMatchesInterval &&
    isFreshWaterxSnapshot(live.updated, snapshot?.serverTime, Date.now(), snapshotToleranceMs) &&
    snapshot?.intervalMinutes === interval;
  const roundRaw = snapshot?.round ?? null;
  const roundCurrent = snapshotCurrent && !!roundRaw &&
    isActiveWaterxRound(snapshot?.intervalMinutes, interval, roundRaw.startMs, roundRaw.expiryMs, serverNow);
  const round = roundCurrent ? roundRaw : null;
  const oddsAge = snapshot?.odds?.asOf ? serverNow - Date.parse(snapshot.odds.asOf) : Infinity;
  const oddsCurrent = !!(roundCurrent && snapshot?.odds && isWaterxMarketSource(snapshot.odds.source) &&
    Number.isFinite(oddsAge) && oddsAge >= -1000 && oddsAge <= 14000);
  const comparisonAge = snapshot?.comparison?.asOf ? serverNow - Date.parse(snapshot.comparison.asOf) : Infinity;
  const comparisonCurrent = !!(roundCurrent && snapshot?.comparison && isCoinbaseSource(snapshot.comparison.source) &&
    Number.isFinite(comparisonAge) && comparisonAge >= -1000 && comparisonAge <= 14000);
  const chartMatchesInterval = chart.loadedUrl === chartUrl;
  const chartSnapshot = chartMatchesInterval ? chart.data : null;
  const selectedBacklog = collectorIntervals[String(interval)] ?? collectorIntervals[`${interval}m`];
  const intervalBacklog = selectedBacklog && typeof selectedBacklog === "object"
    ? (selectedBacklog as Record<string, unknown>).pendingCount
    : collectorInfo?.backlog ?? selectedBacklog;
  const status = live.error && live.errorUrl === liveUrl ? "Refresh failed · live values withheld" :
    live.loading && !snapshot ? "Checking" :
      snapshotCurrent ? String(snapshot?.status ?? "Current") : "Snapshot stale or interval mismatch";
  return <div className="page inner-page">
    <PageTitle index="04" title="Data health"><div className="heading-right"><span className="muted-label">MARKET DURATION</span><IntervalSwitch value={interval} onChange={setInterval} /></div></PageTitle>
    <p className="health-intro">Provenance first. BluewaterAI keeps WaterX's beginning reference, WaterX market odds, and Coinbase comparison feed distinct from Chainlink settlement.</p>
    {live.error && live.errorUrl === liveUrl && !liveMatchesInterval ? <ErrorBox message={live.error} retry={live.reload} /> : !liveMatchesInterval && live.loading ? <Skeleton height={220} /> : <>
      <div className="health-status"><span className={`health-signal ${snapshotCurrent ? "ok" : "warn"}`}><i /> {status}</span><small>API snapshot {snapshotCurrent ? utc(snapshot?.serverTime) : "not current"}</small></div>
      <section className="provenance-grid">
        <article><span className="source-number">01</span><div className="eyebrow">WATERX BEGINNING REFERENCE</div><h2>Price to beat</h2><strong>{roundCurrent ? fmtUsd(round?.referencePrice) : "Withheld"}</strong><p>{roundCurrent ? `Reported by WaterX. ${round?.anchorConfirmed ? "Reference confirmation is reported." : "Confirmation pending; Coinbase is never substituted."}` : "No fresh active-round reference is available."}</p><small>Settlement source: Chainlink BTC/USD TWAP · round {round?.id || "not currently verified"}</small></article>
        <article><span className="source-number">02</span><div className="eyebrow">MARKET PRICES</div><h2>WaterX odds</h2><strong>{oddsCurrent && snapshot?.odds ? `${fmtOdds(snapshot.odds.upPriceCents)} / ${fmtOdds(snapshot.odds.downPriceCents)}` : "Withheld"}</strong><p>{oddsCurrent && snapshot?.odds ? `Source ${snapshot.odds.source} · ${ago(snapshot.odds.asOf)}. Market probabilities, not model forecasts.` : "No fresh WaterX odds for the active round."}</p><small>Interval {interval} minutes</small></article>
        <article><span className="source-number">03</span><div className="eyebrow">COMPARISON ONLY</div><h2>Coinbase live feed</h2><strong>{comparisonCurrent && snapshot?.comparison ? fmtUsd(snapshot.comparison.price) : "Withheld"}</strong><p>{comparisonCurrent && snapshot?.comparison ? `Source ${snapshot.comparison.source} · ${ago(snapshot.comparison.asOf)}. Never used for settlement.` : "No fresh Coinbase comparison for the active round."}</p><small>Separate from the Chainlink settlement TWAP</small></article>
      </section>
      <section className="panel chart-health"><div className="section-head"><div><div className="eyebrow">OBSERVATION ARCHIVE</div><h2>Chart data availability</h2></div><button className="quiet-button" onClick={chart.reload}><RefreshCw size={14} /> Refresh</button></div>
        {chart.error && chart.errorUrl === chartUrl ? <p className="health-warning">{chart.error}</p> : !chartMatchesInterval ? <Skeleton height={125} /> : <div className="health-details"><div><span>Archive source</span><b>{chartSnapshot?.source ?? "Not reported"}</b></div><div><span>Window</span><b>{chartSnapshot?.windowMinutes ?? interval} minutes</b></div><div><span>Returned observations</span><b>{chartSnapshot?.points?.length ?? 0}</b></div><div><span>Coverage</span><b>{chartSnapshot?.coverage?.percent != null ? `${chartSnapshot.coverage.percent}%${chartSnapshot.coverage.partial ? " · partial" : ""}` : chartSnapshot?.coverage?.partial ? "Partial · percent not reported" : "Not reported"}</b></div><div><span>Round phase</span><b>{round?.phase ?? "Unavailable"}</b></div><div><span>Anchor confirmation</span><b>{round?.anchorConfirmed ? "Confirmed" : "Pending / unavailable"}</b></div><div><span>Market interval</span><b>{snapshotCurrent ? `${snapshot?.intervalMinutes}m` : "Unavailable"}</b></div></div>}
        {chartSnapshot?.coverage?.reason && <div className="reference-absent">Coverage note: {chartSnapshot.coverage.reason}</div>}
      </section>
      <section className="panel latency-panel">
        <div className="section-head"><div><div className="eyebrow">MEASURED PIPELINE LATENCY · {interval}M</div><h2>Stage timing diagnostics</h2></div><button className="quiet-button" onClick={latency.reload}><RefreshCw size={14} /> Refresh</button></div>
        <p className="latency-context">Stage percentiles only. Server → publish is process-local. Source age is not proof of round-price latency; browser-side stages are not measured.</p>
        {latency.error && latency.errorUrl === latencyUrl ? <div className="latency-unavailable"><span>Latency diagnostics unavailable.</span><button className="text-button" onClick={latency.reload}>Retry</button></div> : !latencyInfo ? <Skeleton height={82} /> :
          <div className="latency-table">
            <div className="latency-row latency-heading"><span>MEASURED STAGE</span><span>P50</span><span>P95</span><span>P99</span><span>N</span><span>STATUS</span></div>
            {latencyStages.map(({ label, aliases }) => {
              const stage = latencyStage(aliases);
              const count = stage?.sampleCount;
              return <div key={label} className="latency-row"><strong>{label}</strong><span>{latencyNumber(stage, "p50")}</span><span>{latencyNumber(stage, "p95")}</span><span>{latencyNumber(stage, "p99")}</span><span>{typeof count === "number" ? count.toLocaleString() : "—"}</span><span className="latency-status">{typeof stage?.status === "string" ? stage.status : stage ? "reported" : "unavailable"}</span></div>;
            })}
            <div className="latency-row browser-stage"><strong>Browser receipt → chart frame</strong><span>{browserRenderSummary().p50Ms?.toFixed(1) ?? "—"}</span><span>{browserRenderSummary().p95Ms?.toFixed(1) ?? "—"}</span><span>{browserRenderSummary().p99Ms?.toFixed(1) ?? "—"}</span><span>{browserRenderSummary().sampleCount}</span><span className="latency-status">{browserRenderSummary().status} · tab-local</span></div>
          </div>}
      </section>
      <details className="method-card diagnostics-card"><summary><span><CircleHelp size={15} /> Diagnostics and build provenance</span><ChevronDown size={15} /></summary>
        <p>WaterX-specific diagnostics only. These endpoints are kept separate from legacy BTC collector health and learning-model status. Unreported fields remain unavailable.</p>
        <div className="health-details">
          <div><span>WaterX version status</span><b>{version.error ? "Unavailable" : String(versionInfo?.buildStatus ?? versionBuild.status ?? versionInfo?.status ?? "Not reported")}</b></div>
          <div><span>Source status</span><b>{String(versionSource.provenance ?? versionInfo?.sourceStatus ?? "Not reported")}</b></div>
          <div><span>Build ID</span><b>{String(versionBuild.id ?? "Not packaged in development")}</b></div>
          <div><span>Source commit</span><b>{String(versionBuild.sourceCommit ?? "Not packaged in development")}</b></div>
          <div><span>Build timestamp</span><b>{String(versionBuild.builtAt ?? "Not packaged in development")}</b></div>
          <div><span>Schema version</span><b>{String(versionBuild.schemaVersion ?? "Not packaged in development")}</b></div>
          <div><span>WaterX model</span><b>{String(versionInfo?.modelStatus ?? versionModel.status ?? "Not reported")}</b></div>
          <div><span>Collector health</span><b>{collector.error ? "Unavailable" : String(collectorInfo?.collectorHealth ?? collectorInfo?.collectorStatus ?? collectorDetails.status ?? collectorInfo?.status ?? "Not reported")}</b></div>
          <div><span>{interval}m backlog</span><b>{String(intervalBacklog ?? "Not reported")}</b></div>
          <div><span>Health endpoint scope</span><b>WaterX · {interval}m selected</b></div>
        </div>
        {(version.error || collector.error) && <div className="reference-absent">Some diagnostics could not be loaded. This does not change live desk qualification.</div>}
        <div className="chart-foot"><button className="text-button" onClick={() => { version.reload(); collector.reload(); }}>Refresh diagnostics</button><span>Build and collector fields are informational only.</span></div>
      </details>
      <div className="health-warning"><ShieldCheck size={16} /><p><b>Safety behavior:</b> stale values, expired rounds, interval mismatches, and source mismatches are withheld. HOLD is the only current desk decision. No trade action exists.</p></div>
      <div className="live-bottom"><button className="quiet-button" onClick={() => { live.reload(); chart.reload(); }}><RefreshCw size={14} /> Refresh health</button><Link href="/" className="inline-link">Return to live desk</Link></div>
    </>}
  </div>;
}

export default function App() {
  return <Shell><Switch>
    <Route path="/" component={LivePage} />
    <Route path="/history" component={HistoryPage} />
    <Route path="/learn" component={LearningPage} />
    <Route path="/health" component={HealthPage} />
    <Route><div className="page not-found"><div className="eyebrow">NO SUCH VIEW</div><h1>This page isn't on the desk.</h1><Link href="/" className="inline-link">Back to live desk</Link></div></Route>
  </Switch></Shell>;
}