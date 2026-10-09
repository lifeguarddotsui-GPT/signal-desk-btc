import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { Activity, BookOpen, ChevronDown, CircleHelp, Clock3, Database, ExternalLink, Menu, RefreshCw, ShieldAlert, ShieldCheck, Waves, X } from "lucide-react";
import { inspectedPointKey, pointerTimestamp } from "./chart-contract";
import { insertTimestampGaps, isActiveWaterxRound, isCoinbaseSource, isFreshWaterxSnapshot, isWaterxMarketSource, resetSseCursor, selectWaterxOddsDisplay, selectWaterxReference, sseReconnectUrl } from "./waterx-ui-contract";
import { mergeComparisonPoints } from "./chart-contract";
import { browserRenderSummary, recordBrowserRender } from "./browser-latency";
import { type AdvisoryPayload } from "./advisory-contract";
import type { ResearchDailyJob, ResearchInterval, ResearchReport } from "../../shared/waterx-research";
import type { HistorySource } from "../../shared/canonical-history";
import type { RoundDecision } from "../../shared/round-decision";
import type { LockReadinessReport } from "../../shared/lock-readiness";
import CanonicalHistory from "./CanonicalHistory";
import { ResearchLearningPanel } from "./ResearchLearningPanel";
import EarlyLearningJobsPanel from "./EarlyLearningJobsPanel";
import { BluewaterResearchPanel } from "./BluewaterResearchPanel";
import type { BluewaterReport } from "../../shared/bluewater-research";
import { ManualOpportunity } from "./ManualOpportunity";
import "./ManualOpportunity.css";
import { projectExactRoundDecision, projectServerClock, type LiveSnapshotEnvelope } from "./live-decision-contract";
import { useLiveSnapshot } from "./useLiveSnapshot";
import AgentPage from "./AgentPage";
import EarlyLearningSummary from "./EarlyLearningSummary";
import {chartTimeAxis} from "./chart-axis";

type Interval = 5 | 15;
type Point = { at: number | string; price: number | null; source?: string; sourceAt?: number | string | null; eventId?: string | number; gap?: boolean; reason?: string };
type SideAvailability = { probability?: string; price?: string; pricePositive?: boolean; executable?: false; side?: string; reason?: string | null };
type OddsAvailability = { status?: "available" | "partial" | "locked" | "unavailable" | string; reason?: string | null; up?: SideAvailability; down?: SideAvailability };
type Availability = { roundMetadata?: { status?: string; reason?: string | null }; referencePrice?: { status?: string; reason?: string | null }; odds?: OddsAvailability; comparisonPrice?: { status?: string; reason?: string | null } };
type LivePayload = LiveSnapshotEnvelope & {
  serverTime?: string; status?: string; intervalMinutes?: number; reason?: string;
  round?: { id: string; marketId?: string; startMs: number; expiryMs: number; referencePrice: number | null; anchorConfirmed: boolean; phase?: string; url?: string } | null;
  odds?: { up: number | null; down: number | null; upPriceCents: number | null; downPriceCents: number | null; asOf: string; source: string } | null;
  comparison?: { price: number; asOf: string; source: string } | null;
  availability?: Availability;
  learning?: Record<string, unknown>;
  advisory?: AdvisoryPayload & { amountEnteredUsd?: number };
  decision?: RoundDecision | null;
};
type ChartCoverage = { startMs?: number; endMs?: number; expectedSamples?: number; observedSamples?: number; percent?: number; partial?: boolean; status?: string; reason?: string; observationSpanMs?: number; requestedDurationMs?: number; missingStartMs?: number | null; missingEndMs?: number | null; gapCount?: number; observedPointCount?: number; measurement?: string };
type ChartPayload = { windowMinutes: number; source: string; points: Point[]; coverage?: ChartCoverage };
type WaterxHealth = { collector?: { lastValidObservationAt?: string | null; lastError?: string | null } };
type RefreshHealthReport = {
  collector?: unknown;
  captureQueues?: unknown;
  refreshHealth?: {
    scope?: string;
    errors?: Array<{ stage: string; failures: number; lastErrorClass: string | null; atMs: number | null }>;
    alerts?: string[];
    events?: unknown[];
  };
};
type ResearchOperations = {
  status: "ok";
  intervalMinutes: number;
  asOfMs: number;
  cohort: { intervalMinutes: number; window: string; source: HistorySource };
  summary: { correct: number; incorrect: number; pending: number; withdrawn: number; noChoice: number; scored: number; hitRate: number | null; ratio: string; coverage: number | null; total: number };
  operations: { lastCaptureAt: string | null; lastTrainingAt: string | null; lastCalibrationAt: string | null; lastEvaluationAt: string | null; lastCandidateAt: string | null; lastPromotionAt: string | null; blockers: string[]; trainingCount: number };
  definitions: { history: string; training: string };
  dailyJob: ResearchDailyJob;
};

const historySourceLabel = (source: HistorySource) => source === "baseline" ? "WaterX market baseline"
  : source === "bluewater" ? "Bluewater champion" : "Deterministic 50/50 fallback · research-only";

function useApi<T>(url: string, refreshMs = 0, enabled = true) {
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
    if (!enabled) {
      setData(null); setLoading(false); setError(""); setErrorUrl(""); setLoadedUrl("");
      return;
    }
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
  }, [url, nonce, enabled]);
  useEffect(() => {
    if (!refreshMs || loading || !enabled) return;
    let disposed = false;
    const timer = window.setTimeout(() => { if (!disposed) reload(); }, refreshMs);
    return () => { disposed = true; clearTimeout(timer); };
  }, [url, refreshMs, reload, loading, enabled]);
  return { data, error, errorUrl, loading, updated, loadedUrl, reload };
}

function useIntervalPreference() {
  const [value, setValue] = useState<Interval>(() => {
    const params = new URLSearchParams(window.location.search);
    if (import.meta.env.DEV && params.has("fixture") && (params.get("interval") === "5" || params.get("interval") === "15"))
      return Number(params.get("interval")) as Interval;
    try { return window.localStorage.getItem("bluewater.interval") === "15" ? 15 : 5; }
    catch { return 5; }
  });
  const change = useCallback((next: Interval) => {
    setValue(next);
    try { window.localStorage.setItem("bluewater.interval", String(next)); } catch { /* storage may be unavailable */ }
    if (import.meta.env.DEV) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("fixture")) {
        params.set("interval", String(next));
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      }
    }
  }, []);
  return [value, change] as const;
}

const fmtUsd = (value?: number | null) => value == null || !Number.isFinite(value)
  ? "—" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtOdds = (value?: number | null) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}¢`;
const fmtProbability = (value?: number | null) => value == null || !Number.isFinite(value) || value < 0 || value > 1 ? "—" : `${(value * 100).toFixed(1)}%`;
const durationLabel = (value?: number | null) => {
  if (value == null || !Number.isFinite(value)) return "not reported";
  const seconds = Math.max(0, Math.floor(value / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
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
  const nav = [{ href: "/", label: "Live desk", icon: Activity }, { href: "/history", label: "Round history", icon: Clock3 }, { href: "/learn", label: "Learning", icon: BookOpen }, { href: "/health", label: "Data health", icon: Database }, { href: "/agent", label: "Agent", icon: ShieldCheck }];
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
  const [chartWindow, setChartWindow] = useState<"observed" | "round" | 5 | 15>("observed");
  const [now, setNow] = useState(Date.now());
  const rolloverSince = useRef<number | null>(null);
  const fixtureNames = ["normal", "high-likelihood-up", "high-likelihood-down", "favorable-risk-reward-up", "favorable-risk-reward-down", "wait", "unvalidated", "stale-quote", "missing-odds", "collector-stalled", "loading", "request-failure", "rollover", "too-late", "locked"] as const;
  const requestedFixture = new URLSearchParams(window.location.search).get("fixture");
  const fixtureMode = import.meta.env.DEV && fixtureNames.includes(requestedFixture as typeof fixtureNames[number])
    ? requestedFixture as typeof fixtureNames[number] : null;
  const [fixtureControlsOpen, setFixtureControlsOpen] = useState(false);
  useEffect(() => {
    const onResize = () => { if (fixtureMode) setFixtureControlsOpen(true); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fixtureMode]);
  const liveUrl = `/api/waterx/advisory?interval=${interval}&amount=5`;
  const chartUrl = `/api/waterx/chart?interval=${interval}&window=${chartWindow === "round" || chartWindow === "observed" ? interval : chartWindow}`;
  const learningUrl = `/api/waterx/model?interval=${interval}`;
  const healthUrl = `/api/waterx/health?interval=${interval}`;
  const researchUrl = `/api/waterx/research?interval=${interval}`;
  const lockReadinessUrl = `/api/waterx/lock-readiness?interval=${interval}`;
  const bluewaterUrl = `/api/waterx/bluewater?interval=${interval}`;
  const live = useLiveSnapshot<LivePayload>(liveUrl, interval, !fixtureMode);
  const validatedAtomicSnapshot = useRef<{ url: string; data: LivePayload } | null>(null);
  const chart = useApi<ChartPayload>(chartUrl, 30000, !fixtureMode);
  const learning = useApi<Record<string, unknown>>(learningUrl, 60000, !fixtureMode);
  const health = useApi<WaterxHealth>(healthUrl, 10000, !fixtureMode);
  const research = useApi<ResearchReport>(researchUrl, 60000, !fixtureMode);
  const lockReadiness = useApi<LockReadinessReport>(lockReadinessUrl, 60000, !fixtureMode);
  const bluewater = useApi<BluewaterReport>(bluewaterUrl, 5000, !fixtureMode);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const fixtureNow = now;
  const fixturePhase=fixtureMode?new URLSearchParams(window.location.search).get("phase"):null;
  const fixtureStart = useMemo(() => Date.now() - (fixturePhase==="start"?2000:
    fixturePhase==="middle"?interval*30000:fixturePhase==="close"?interval*60000-5000:60000),
    [interval,fixtureMode,fixturePhase]);
  const fixtureRound = fixtureMode === "rollover" || fixtureMode === "collector-stalled" || fixtureMode === "loading" || fixtureMode === "request-failure" ? null : {
    id: `DEV-FIXTURE-${interval}-${fixtureStart}`,
    marketId: `DEV-MARKET-${interval}`,
    startMs: fixtureMode === "too-late" ? fixtureStart - interval * 60_000 : fixtureStart,
    expiryMs: fixtureMode === "too-late" ? fixtureNow - 1 : fixtureStart + interval * 60_000,
    referencePrice: 83642.18, anchorConfirmed: true, phase: "ROUND IN PROGRESS",
  };
  const fixturePayload: LivePayload | null = fixtureMode ? fixtureMode === "loading" || fixtureMode === "request-failure" ? null : fixtureMode === "rollover" ? {
    serverTime: new Date(fixtureNow).toISOString(), status: "COLLECTION_DELAYED", intervalMinutes: interval,
    reason: "Fixture: active round discovery is delayed beyond the normal rollover window.", round: null,
    odds: null, comparison: { price: 83671.42, asOf: new Date(fixtureNow).toISOString(), source: "Coinbase (fixture)" },
  } : {
    serverTime: new Date(fixtureNow).toISOString(),
    status: fixtureMode === "collector-stalled" ? "COLLECTION_DELAYED" : "LIVE", intervalMinutes: interval, round: fixtureRound,
    odds: fixtureMode === "stale-quote" || fixtureMode === "missing-odds" || fixtureMode === "collector-stalled" ? null : {
      up: .583, down: .417,
      upPriceCents: fixtureMode === "locked" ? 0 : 58, downPriceCents: fixtureMode === "locked" ? 0 : 42,
      asOf: new Date(fixtureNow).toISOString(), source: "WaterX (fixture)",
    },
    comparison: { price: 83671.42, asOf: new Date(fixtureNow).toISOString(), source: "Coinbase (fixture)" },
    availability: { referencePrice: { status: "available" }, odds: fixtureMode === "missing-odds" ? { status: "unavailable", reason: "Fixture: current probabilities are missing." } : fixtureMode === "stale-quote" ? { status: "unavailable", reason: "Fixture: $5 quote is stale." } : fixtureMode === "collector-stalled" ? { status: "unavailable", reason: "Fixture: market snapshot is stale." } : fixtureMode === "locked" ? { status: "locked", up: { side: "locked" }, down: { side: "locked" } } : { status: "available" } },
  } : null;
  // Keep the selected interval internally consistent; freshness gates withhold
  // responses that arrive for a different market cadence.
  const payload = fixtureMode ? fixturePayload
    : live.data?.intervalMinutes === interval ? live.data : null;
  const round = payload?.round ?? null;
  const serverMs = payload?.serverTime ? Date.parse(payload.serverTime) : NaN;
  const serverNow = fixtureMode ? now : Number.isFinite(serverMs) ? projectServerClock(serverMs, live.updated, now) : now;
  const snapshotToleranceMs = interval === 5 ? 16_000 : 31_000;
  const snapshotCurrent = !!fixtureMode || (live.loadedUrl === liveUrl &&
    isFreshWaterxSnapshot(live.updated, payload?.serverTime, now, snapshotToleranceMs) &&
    payload?.intervalMinutes === interval);
  const roundCurrent = snapshotCurrent && !!round && isActiveWaterxRound(payload?.intervalMinutes, interval, round.startMs, round.expiryMs, serverNow);
  const activeMetadataRound = !fixtureMode && snapshotCurrent && roundCurrent && round
    ? { id: round.id, startMs: round.startMs, expiryMs: round.expiryMs } : null;
  const receivedAtomicSnapshot = !fixtureMode && live.atomicLoadedUrl === liveUrl &&
    live.atomicData?.decision && live.atomicData.round ? live.atomicData : null;
  if (receivedAtomicSnapshot) validatedAtomicSnapshot.current = { url: liveUrl, data: receivedAtomicSnapshot };
  const cachedAtomicSnapshot = !fixtureMode && validatedAtomicSnapshot.current?.url === liveUrl
    ? validatedAtomicSnapshot.current.data : null;
  const atomicEnvelope = receivedAtomicSnapshot ?? cachedAtomicSnapshot;
  const verifiedRootRound = live.loadedUrl === liveUrl && payload?.intervalMinutes === interval
    ? payload.round ?? null : null;
  const cachedRound = cachedAtomicSnapshot?.round;
  const verifiedDifferentRound = !!verifiedRootRound && !!cachedRound &&
    (verifiedRootRound.id !== cachedRound.id || verifiedRootRound.startMs !== cachedRound.startMs ||
      verifiedRootRound.expiryMs !== cachedRound.expiryMs);
  const retainedDecisionRound = cachedRound && !verifiedDifferentRound && serverNow < cachedRound.expiryMs
    ? { id: cachedRound.id, startMs: cachedRound.startMs, expiryMs: cachedRound.expiryMs } : null;
  const decisionRound = fixtureMode && roundCurrent && round
    ? { id: round.id, startMs: round.startMs, expiryMs: round.expiryMs }
    : activeMetadataRound ?? retainedDecisionRound;
  const rootHealthMatchesIdentity = !!payload?.dataHealth &&
    (roundCurrent && !!round && !!decisionRound &&
      round.id === decisionRound.id && round.startMs === decisionRound.startMs && round.expiryMs === decisionRound.expiryMs ||
      !round && !decisionRound && payload.dataHealth.round.status === "ROUND_UNAVAILABLE");
  const rootHealthMatchesAtomicRound = !!rootHealthMatchesIdentity && !!decisionRound && !!atomicEnvelope?.round &&
    atomicEnvelope.round.id === decisionRound.id &&
    atomicEnvelope.round.startMs === decisionRound.startMs &&
    atomicEnvelope.round.expiryMs === decisionRound.expiryMs;
  const projectionEnvelope = !fixtureMode && rootHealthMatchesAtomicRound && payload?.dataHealth && atomicEnvelope
    ? { ...atomicEnvelope, dataHealth: payload.dataHealth } : atomicEnvelope;
  const decisionProjection = fixtureMode
    ? projectExactRoundDecision(null, interval, null, serverNow)
    : projectExactRoundDecision(projectionEnvelope, interval, decisionRound, serverNow);
  const atomicDecisionView = {
    ...decisionProjection,
    dataHealth: decisionProjection.dataHealth ??
      (rootHealthMatchesIdentity ? payload?.dataHealth : undefined) ??
      (fixtureMode === "missing-odds" ? {
        transport: { status: "HEALTHY", lastReceivedAtMs: fixtureNow, errorClass: null },
        round: { status: "KNOWN" }, reference: { status: "CONFIRMED" },
        probabilities: { status: "PROBABILITIES_MISSING", lastValid: null },
        storage: { status: "UNKNOWN", errorClass: null },
        execution: { eligible: false, reason: "Research only." },
        primaryReason: "PROBABILITIES_MISSING",
      } as NonNullable<LivePayload["dataHealth"]> : undefined),
  };
  const snapshotRefreshState = {
    pending: fixtureMode === "loading" || !fixtureMode && live.loading,
    error: fixtureMode === "request-failure" ? "Request failed. The current round has not been inferred." : !fixtureMode && live.errorUrl === liveUrl ? live.error : "",
    retryCount: fixtureMode ? 0 : live.retryCount,
    failureCount: fixtureMode ? 0 : live.failureCount,
  };
  useEffect(() => {
    const waitingOnRound = !roundCurrent && ["STALE", "ROLLOVER", "COLLECTION_DELAYED"].includes(payload?.status || "");
    if (waitingOnRound && rolloverSince.current == null) rolloverSince.current = now;
    if (!waitingOnRound) rolloverSince.current = null;
  }, [payload?.status, roundCurrent, now]);
  const roundOutageSeconds = rolloverSince.current == null ? 0 : Math.max(0, Math.floor((now - rolloverSince.current) / 1000));
  const boundaryAgeSeconds = Math.max(0, Math.floor((serverNow % (interval * 60_000)) / 1000));
  const lastValidAt = !fixtureMode && health.loadedUrl === healthUrl && !health.error
    ? Date.parse(health.data?.collector?.lastValidObservationAt || "") : NaN;
  const outageAge = Number.isFinite(lastValidAt) && lastValidAt <= now
    ? durationLabel(now - lastValidAt) : durationLabel(roundOutageSeconds * 1000);
  const outageDetail = health.loadedUrl === healthUrl && !health.error && health.data?.collector?.lastError
    ? ` · ${health.data.collector.lastError}` : "";
  const referenceAvailability = payload?.availability?.referencePrice;
  const waterxReference = selectWaterxReference(roundCurrent, round?.referencePrice, referenceAvailability?.status);
  const waterxReferenceValid = waterxReference !== null;
  const comparison = payload?.comparison;
  const comparisonMs = comparison?.asOf ? Date.parse(comparison.asOf) : NaN;
  const comparisonFresh = !!comparison && Number.isFinite(comparisonMs) &&
    comparisonMs <= (Number.isFinite(serverNow) ? serverNow : now) + 1000 &&
    now - comparisonMs <= 14000 && now - comparisonMs >= -1000 &&
    isCoinbaseSource(comparison.source);
  const decisionMarket = !fixtureMode && atomicDecisionView.fresh
    ? atomicDecisionView.decision?.market ?? null : null;
  const atomicOdds = !fixtureMode ? atomicEnvelope?.odds ?? null : null;
  const atomicOddsAsOfMs = atomicOdds?.asOf ? Date.parse(atomicOdds.asOf) : NaN;
  const atomicQuoteMatchesDecision = !!decisionMarket && !!atomicOdds &&
    Number.isFinite(atomicOddsAsOfMs) && atomicOddsAsOfMs === decisionMarket.observedAtMs &&
    atomicOdds.up === decisionMarket.probabilityUp && atomicOdds.down === decisionMarket.probabilityDown;
  const odds = fixtureMode ? payload?.odds : atomicQuoteMatchesDecision ? atomicOdds : null;
  const oddsAvailability = fixtureMode ? payload?.availability?.odds
    : atomicQuoteMatchesDecision ? atomicEnvelope?.availability?.odds : undefined;
  const oddsDisplay = selectWaterxOddsDisplay({
    snapshotCurrent: fixtureMode ? snapshotCurrent : atomicQuoteMatchesDecision,
    roundCurrent: fixtureMode ? roundCurrent : atomicQuoteMatchesDecision,
    requestedInterval: interval,
    responseInterval: fixtureMode ? payload?.intervalMinutes : atomicEnvelope?.intervalMinutes,
    roundId: fixtureMode ? round?.id : atomicEnvelope?.round?.id,
    roundStartMs: fixtureMode ? round?.startMs : atomicEnvelope?.round?.startMs,
    serverNowMs: serverNow,
    odds,
    availability: oddsAvailability,
  });
  const oddsFresh = oddsDisplay.fresh;
  const upLocked = oddsDisplay.up.locked;
  const downLocked = oddsDisplay.down.locked;
  const lockedPair = oddsDisplay.lockedPair;
  const upProbabilityCurrent = oddsDisplay.up.probability !== null;
  const downProbabilityCurrent = oddsDisplay.down.probability !== null;
  const atomicEnvelopeRoundMatches = !!decisionRound && !!atomicEnvelope?.round &&
    atomicEnvelope.round.id === decisionRound.id &&
    atomicEnvelope.round.startMs === decisionRound.startMs &&
    atomicEnvelope.round.expiryMs === decisionRound.expiryMs;
  const advisoryMarketId = atomicEnvelopeRoundMatches ? atomicEnvelope?.round?.marketId
    : roundCurrent && round && decisionRound && round.id === decisionRound.id ? round.marketId : undefined;
  const expectedAdvisoryIdentity = fixtureMode && round?.marketId ? {
    marketId: round.marketId, roundId: round.id, intervalMinutes: interval,
    startMs: round.startMs, expiryMs: round.expiryMs,
  } : !fixtureMode && decisionRound && advisoryMarketId ? {
    marketId: advisoryMarketId, roundId: decisionRound.id, intervalMinutes: interval,
    startMs: decisionRound.startMs, expiryMs: decisionRound.expiryMs,
  } : null;
  const atomicAdvisory = !fixtureMode && atomicEnvelopeRoundMatches
    ? atomicEnvelope?.advisory : null;
  const matchedAdvisory = !fixtureMode && !!expectedAdvisoryIdentity &&
    atomicEnvelopeRoundMatches &&
    atomicAdvisory?.identity?.marketId === expectedAdvisoryIdentity.marketId &&
    atomicAdvisory?.identity?.roundId === expectedAdvisoryIdentity.roundId &&
    atomicAdvisory?.identity?.intervalMinutes === expectedAdvisoryIdentity.intervalMinutes &&
    atomicAdvisory?.identity?.startMs === expectedAdvisoryIdentity.startMs &&
    atomicAdvisory?.identity?.expiryMs === expectedAdvisoryIdentity.expiryMs &&
    atomicAdvisory?.amountEnteredUsd === 5 ? atomicAdvisory : null;
  const fixtureClassification = fixtureMode?.startsWith("high-likelihood") ? "HIGH_LIKELIHOOD"
    : fixtureMode?.startsWith("favorable-risk-reward") ? "FAVORABLE_RISK_REWARD" : "OBSERVE";
  const selectedFixtureSide = fixtureMode?.endsWith("-down") ? "down" : "up";
  const fixtureProof = (side: "up" | "down") => {
    if (!fixtureRound || !["HIGH_LIKELIHOOD", "FAVORABLE_RISK_REWARD"].includes(fixtureClassification) || fixtureMode === "unvalidated") return undefined;
    const quoteExpiry = fixtureMode === "stale-quote" ? fixtureNow - 1 : fixtureNow + 12_000;
    const cutoffAtMs = fixtureRound.expiryMs - 30_000;
    const positiveSide = side === selectedFixtureSide;
    const sideClassification = positiveSide ? fixtureClassification : "OBSERVE";
    const netWinningReceipt = sideClassification === "FAVORABLE_RISK_REWARD" ? 11.9 : 9.8;
    const lowerBound = sideClassification === "HIGH_LIKELIHOOD" ? .82 : .64;
    const expectedNet = lowerBound * netWinningReceipt - 5;
    return {
      fixture: true,
      side,
      identity: { marketId: fixtureRound.marketId, roundId: fixtureRound.id, intervalMinutes: interval, startMs: fixtureRound.startMs, expiryMs: fixtureRound.expiryMs },
      reference: {
        marketId: fixtureRound.marketId, roundId: fixtureRound.id, intervalMinutes: interval,
        startMs: fixtureRound.startMs, expiryMs: fixtureRound.expiryMs,
        sourceName: "WaterX confirmed round reference", confirmed: true,
        price: fixtureRound.referencePrice, observedAtMs: fixtureNow,
      },
      executionQuote: {
        kind: "accurate-simulation", quoteId: `DEV-${fixtureMode}-${side}`,
        marketId: fixtureRound.marketId,
        roundId: fixtureRound.id, intervalMinutes: interval, startMs: fixtureRound.startMs, expiryMs: fixtureRound.expiryMs,
        side, amountUsd: 5, executable: false, simulationVerified: true, costVerified: true, netReceiptVerified: true, receiptVerified: true,
        feesIncluded: true, minimumsIncluded: true, priceImpactIncluded: true,
        totalCostUsd: 5, grossWinningReceiptUsd: netWinningReceipt + .1, winningFeesUsd: .1,
        netWinningReceiptUsd: netWinningReceipt, losingGrossReceiptUsd: 0, losingFeesUsd: 0,
        netProfitIfWinUsd: netWinningReceipt - 5, lossIfLoseUsd: 5,
        conservativeExpectedNetValueUsd: expectedNet,
        quotedAtMs: fixtureNow, expiresAtMs: quoteExpiry, synthetic: true,
      },
      model: {
        marketId: fixtureRound.marketId, roundId: fixtureRound.id, intervalMinutes: interval, side,
        status: "promoted", independent: true, heldoutForwardAccepted: true,
        policyId: "waterx-value-policy-v1",
        version: "DEV-SYNTHETIC-ONLY", evidenceCount: 142, qualifiedSampleCount: 142,
        evidenceId: `DEV-SYNTHETIC-VALIDATION-SAMPLE-${side}`,
        calibratedProbability: lowerBound + .03, lowerBoundProbability: lowerBound, uncertaintyMargin: .02,
        calibration: { method: "fixture calibration", lowerBoundMethod: "fixture conservative bound", verified: true },
        probabilityAtMs: fixtureNow,
      },
      timing: {
        cutoffVerified: true, cutoffSource: "DEV-SYNTHETIC-ROUND-CUTOFF",
        cutoffAtMs, measuredAtMs: fixtureNow, measuredBufferMs: cutoffAtMs - fixtureNow,
        requiredBufferMs: 10_000,
      },
    };
  };
  const fixtureAdvisory: AdvisoryPayload | null = fixtureMode ? ({
    state: "OBSERVE",
    amountEnteredUsd: 5,
    reason: fixtureMode === "wait" ? "Evidence is mixed; neither direction clears the decision threshold."
     : fixtureMode === "unvalidated" ? "Illustrative direction only; calibration evidence is intentionally absent."
        : fixtureMode === "stale-quote" ? "Quote-age gate should suppress this otherwise favorable-looking state."
          : fixtureMode === "collector-stalled" ? "Collector stalled; no current round evidence can support an advisory."
            : fixtureMode === "rollover" ? "Awaiting discovery of the next active round."
              : fixtureMode === "too-late" ? "Round has expired; the prior identity must not carry forward."
                : fixtureMode === "locked" ? "Market sides are locked and unavailable."
                  : "Development-only calibrated sample; this is not a live WaterX recommendation.",
    identity: fixtureRound ? { marketId: fixtureRound.marketId, roundId: fixtureRound.id, intervalMinutes: interval, startMs: fixtureRound.startMs, expiryMs: fixtureRound.expiryMs } : null,
     sides: {
       up: { state: selectedFixtureSide === "up" ? fixtureClassification : "OBSERVE", quote: fixtureMode === "unvalidated" ? {} : { calibratedProbability: .641, estimatedExpectedNetValue: .183, breakEvenProbability: .518, ageMs: fixtureMode === "stale-quote" ? 46_000 : 1_200 } },
       down: { state: selectedFixtureSide === "down" ? fixtureClassification : "OBSERVE", quote: { calibratedProbability: .359, estimatedExpectedNetValue: -.183, breakEvenProbability: .482, ageMs: 1_200 } },
    },
     proof: fixtureClassification !== "OBSERVE" || fixtureMode === "stale-quote"
      ? { up: fixtureProof("up"), down: fixtureProof("down") } : undefined,
   } as AdvisoryPayload) : null;
  const roundProvisional = waterxReferenceValid && (referenceAvailability?.status === "provisional" || round?.anchorConfirmed === false);
  const deskState = fixtureMode === "rollover" ? "Collection delayed · active round not discovered"
    : !roundCurrent
    ? live.error && live.errorUrl === liveUrl ? `Snapshot stale · last valid ${outageAge} ago`
      : payload?.status === "STALE" || payload?.status === "COLLECTION_DELAYED" ? `Collection problem · ${payload?.reason || "no active round"} · last valid ${outageAge} ago${outageDetail}`
        : payload?.status === "ROLLOVER" ? boundaryAgeSeconds > 30 ? `Collection problem · no active round ${boundaryAgeSeconds}s after boundary` : `Round rollover · awaiting active round · ${boundaryAgeSeconds}s after boundary`
        : payload ? "No active round · values withheld" : "Checking live round"
    : !waterxReferenceValid ? "Live round · reference unavailable"
      : roundProvisional ? "Live round · provisional reference" : "Live round · reference reported";
  const waterxLean = upProbabilityCurrent && downProbabilityCurrent && odds
    ? odds.up! > odds.down! ? "UP-leaning"
      : odds.down! > odds.up! ? "DOWN-leaning" : "Balanced"
    : "Not enough current odds";
  const modelData = learning.loadedUrl === learningUrl && !learning.error ? learning.data ?? {} : {};
  const learningSplit = modelData.split && typeof modelData.split === "object" ? modelData.split as Record<string, unknown> : {};
  const candidateTraining = modelData.candidateTraining && typeof modelData.candidateTraining === "object" ? modelData.candidateTraining as Record<string, unknown> : {};
  const forwardEvaluation = candidateTraining.forwardPredictionEvaluation && typeof candidateTraining.forwardPredictionEvaluation === "object"
    ? candidateTraining.forwardPredictionEvaluation as Record<string, unknown> : {};
  const learningTrainCount = typeof learningSplit.trainingCount === "number" ? learningSplit.trainingCount : null;
  const forwardCount = typeof forwardEvaluation.storedPredictionCount === "number"
    ? forwardEvaluation.storedPredictionCount : null;
  const fixturePoints: Point[] = fixtureMode ? Array.from({ length: 33 }, (_, i) => {
    const at = fixtureNow - (32 - i) * 7000;
    return { at, price: i === 32 ? 83671.42 : 83642.18 + Math.sin(i * .45) * 17 + i * .45, source: "Coinbase (fixture)" };
  }) : [];
  const chartPayload = fixtureMode ? { windowMinutes: interval, source: "Coinbase (fixture)", points: fixturePoints } : chart.loadedUrl === chartUrl ? chart.data : null;
  const archiveMatches = isCoinbaseSource(chartPayload?.source);
  const acceptedPoints = (archiveMatches ? chartPayload?.points ?? [] : []).map(p => ({ ...p, at: typeof p.at === "string" ? Date.parse(p.at) : p.at }))
    .filter(p => Number.isFinite(p.at) && (p.price == null || (Number.isFinite(p.price) && p.price > 0)));
  const [stream, setStream] = useState<Point[]>([]);
  const [streamStatus, setStreamStatus] = useState<"CONNECTING" | "LIVE" | "RECONNECTING" | "FIXTURE">("CONNECTING");
  const streamRef = useRef<EventSource | null>(null);
  const streamCursor = useRef("");
  const pendingPaint = useRef<{ id: string; receivedAt: number } | null>(null);
  useEffect(() => {
    if (fixtureMode) { setStreamStatus("FIXTURE"); return; }
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
        const eventSource = typeof body.source === "string" ? body.source : "Not reported";
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
  }, [fixtureMode]);
  const latestStreamPoint = stream.at(-1);
  const latestStreamAt = latestStreamPoint
    ? typeof latestStreamPoint.at === "number" ? latestStreamPoint.at : Date.parse(latestStreamPoint.at)
    : NaN;
  const streamCoinbaseFresh = !fixtureMode && !!latestStreamPoint && !latestStreamPoint.gap &&
    isCoinbaseSource(latestStreamPoint.source) && typeof latestStreamPoint.price === "number" &&
    Number.isFinite(latestStreamPoint.price) && latestStreamPoint.price > 0 &&
    Number.isFinite(latestStreamAt) && now - latestStreamAt >= -1000 && now - latestStreamAt <= 14_000;
  const coinbasePriceFresh = comparisonFresh || streamCoinbaseFresh;
  const coinbaseDisplayPrice = comparisonFresh ? comparison?.price ?? null
    : streamCoinbaseFresh ? latestStreamPoint?.price ?? null : null;
  const coinbaseDisplayAt = comparisonFresh ? comparison?.asOf : streamCoinbaseFresh ? latestStreamPoint?.at : undefined;
  const coinbaseDisplaySource = comparisonFresh ? comparison?.source ?? ""
    : streamCoinbaseFresh ? latestStreamPoint?.source ?? "" : "";
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
    if (fixtureMode) return fixturePoints.map(point => ({ ...point, at: Number(point.at) }));
    return insertTimestampGaps(
      mergeComparisonPoints(
        acceptedPoints.map(point => ({ ...point, at: Number(point.at) })),
        stream.map(point => ({ ...point, at: Number(point.at) })),
      ).filter(point => Number(point.at) >= Date.now() - 15 * 60_000),
      14_000,
    );
  }, [acceptedPoints, stream, fixtureMode, fixtureNow]);

  return <div className="page live-page">
      <div className="desk-toolbar">
      <div className="desk-market"><span className="eyebrow">LIVE DESK</span></div>
      <div className="heading-right"><IntervalSwitch value={interval} onChange={setInterval} /></div>
    </div>
    {import.meta.env.DEV && <details className="fixture-banner fixture-picker" open={fixtureControlsOpen} onToggle={event => setFixtureControlsOpen(event.currentTarget.open)}>
      <summary>{fixtureMode ? "DEVELOPMENT-ONLY FIXTURES" : "DEVELOPMENT PREVIEW"} <span>{fixtureMode ? "synthetic test data · live polling disabled" : "Live API observations · no fixture active"}</span></summary>
      <select id="advisory-fixture" value={fixtureMode || ""} onChange={event => {
        const value = event.target.value;
        window.location.href = value ? `${window.location.pathname}?fixture=${encodeURIComponent(value)}&interval=${interval}` : window.location.pathname;
      }}>
        <option value="">Live API response</option>
        {fixtureNames.map(name => <option key={name} value={name}>{name.toUpperCase().replaceAll("-", " ")}</option>)}
      </select>
    </details>}
      <ManualOpportunity
        view={atomicDecisionView}
        now={serverNow}
        interval={interval}
        round={roundCurrent && round ? { id: round.id, startMs: round.startMs, expiryMs: round.expiryMs } : null}
        fixtureName={fixtureMode}
        marketReference={{
          price: waterxReferenceValid ? round?.referencePrice ?? null : null,
          quality: roundProvisional ? "provisional" : waterxReferenceValid ? "confirmed" : "unavailable",
          source: "WaterX round reference",
        }}
        comparison={{
          price: coinbasePriceFresh ? coinbaseDisplayPrice : null,
          source: coinbaseDisplaySource || "Not reported",
          receivedAtMs: coinbasePriceFresh && coinbaseDisplayAt
            ? typeof coinbaseDisplayAt === "number" ? coinbaseDisplayAt : Date.parse(coinbaseDisplayAt) : null,
        }}
        refresh={{ pending: snapshotRefreshState.pending, error: snapshotRefreshState.error }}
        economics={matchedAdvisory}
        onRetry={fixtureMode ? () => { window.location.href = window.location.pathname; } : live.reload}
      >
      <div className="chart-market-layout">
        <section className="chart-panel">
        <div className="section-head chart-head"><div><div className="eyebrow">PRICE OBSERVATIONS</div><h2>BTC / USD</h2><p>Observed prices only · missing intervals remain blank.</p></div><span className={`feed-pill ${streamStatus.toLowerCase()}`}><i />{streamStatus}</span></div>
          {!fixtureMode && chart.error && chart.errorUrl === chartUrl && !chartPayload && !merged.length ? <div className="chart-empty"><Activity size={22} /><strong>Archive unavailable</strong><span>The live comparison feed remains independent.</span></div> : !fixtureMode && chart.loading && !chartPayload && !merged.length ? <Skeleton height={330} /> :
             <PriceChart points={merged} interval={interval} anchor={waterxReferenceValid ? round?.referencePrice ?? null : null} streamStatus={streamStatus} round={roundCurrent ? round : null} archiveWindow={chartPayload?.windowMinutes} coveragePartial={chartPayload?.coverage?.partial === true} windowMode={chartWindow} onWindowChange={setChartWindow} />
          }
         {chart.error && chart.errorUrl === chartUrl && <div className="reference-absent">Archive unavailable. Live comparison observations remain visible where available.</div>}
          {chartPayload?.coverage?.partial && (typeof chartWindow === "number" || chartWindow === "round") && <div className="gap-caption">Rolling archive coverage{chartPayload.coverage.percent != null ? ` · ${chartPayload.coverage.percent}% reported` : ""}{chartPayload.coverage.reason ? ` · ${chartPayload.coverage.reason}` : ""}. This does not describe complete coverage of the current round.</div>}
        {chartPayload && !archiveMatches && <div className="gap-caption">Archive source mismatch: historical points withheld; expected Coinbase comparison data.</div>}
        <div className="legend-row"><span><i className="legend-price" /> Coinbase observations</span><span><i className="legend-anchor" /> WaterX price to beat</span><span className="legend-stamp">Archive: {chartPayload?.source || "not reported"} · stream: Coinbase</span></div>
        <div className="chart-foot"><span>{merged.length.toLocaleString()} retained archive + live observations{typeof chartWindow === "number" ? ` · rolling archive coverage ${chartPayload?.coverage?.percent == null ? "not reported" : `${chartPayload.coverage.percent}%`}` : " · active-round window; archive coverage is separate"}</span></div>
      </section>
      </div>
      </ManualOpportunity>
  </div>;
}

function PriceChart({ points, interval, anchor, streamStatus, round, archiveWindow, coveragePartial, windowMode, onWindowChange }: { points: Point[]; interval: Interval; anchor: number | null; streamStatus: string; round: LivePayload["round"]; archiveWindow?: number; coveragePartial: boolean; windowMode: "observed" | "round" | 5 | 15; onWindowChange: (mode: "observed" | "round" | 5 | 15) => void }) {
  const measureRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [chartHeight,setChartHeight]=useState(460);
  const [textScale,setTextScale]=useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const update = () => {
      setWidth(Math.max(180, Math.round(element.getBoundingClientRect().width)));
      if(svgRef.current)setChartHeight(Math.max(180,Math.round(svgRef.current.getBoundingClientRect().height)));
      setTextScale(Math.max(1,parseFloat(getComputedStyle(document.documentElement).fontSize)/16));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const compact = width < 390;
  const H = chartHeight, left = compact ? 51 : 74, right = compact ? 20 : 30, top = 36, bottom = 20;
  const plotRight = width - right;
  const nowAt = Date.now();
  const pointTimes = points.map(p => Number(p.at)).filter(at => Number.isFinite(at) && at <= nowAt);
  const latestTime = Math.max(nowAt, ...pointTimes);
  const activeWindowMode = windowMode === "round" && !round ? interval : windowMode;
  const windowMinutes: Interval = activeWindowMode === "round" || activeWindowMode === "observed" ? interval : activeWindowMode;
  const roundWindow = (activeWindowMode === "round" || activeWindowMode === "observed") && !!round;
  const duration = roundWindow && round ? round.expiryMs - round.startMs : windowMinutes * 60_000;
  const start = roundWindow && round ? round.startMs : latestTime - duration;
  const end = roundWindow && round ? round.expiryMs : latestTime;
  const visible = points.filter(p => Number(p.at) >= start && Number(p.at) <= end && Number(p.at) <= nowAt);
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
  const partialWindow = activeWindowMode === "round" ? coveragePartial
    : typeof activeWindowMode === "number" && (coveragePartial || archiveWindow != null && activeWindowMode > archiveWindow);
  const startInside = !!round && round.startMs >= start && round.startMs <= end;
  const endInside = !!round && round.expiryMs >= start && round.expiryMs <= end;
  const nowInside = nowAt >= start && nowAt <= end;
  const nowX = x(nowAt);
  const nowLabelRightAligned = nowX > plotRight - 36;
  const nowLabelX = nowLabelRightAligned ? Math.max(left + 6, nowX - 5) : Math.min(nowX + 5, plotRight - 4);
  const axisTicks=chartTimeAxis(start,end,plotRight-left,textScale);
   return <div ref={measureRef} className="chart-wrap">
    <div className="chart-controls" role="group" aria-label="Chart time window">
      {(["observed", "round", 5, 15] as const).map(mode => <button key={mode} className={activeWindowMode === mode ? "active" : ""} aria-pressed={activeWindowMode === mode} disabled={mode === "round" && !round} onClick={() => { onWindowChange(mode); setSelectedKey(null); }}>{mode === "observed" ? "Observed" : mode === "round" ? "Round window" : `Last ${mode}m`}</button>)}
       <span>{activeWindowMode === "round" ? "Round window · future unobserved" : activeWindowMode === "observed" ? round ? "Active round · future unobserved" : "Recent observations · no active round" : "Rolling archive"}{partialWindow ? " · partial" : ""}</span>
      {active && <button className="return-live" onClick={() => setSelectedKey(null)}>Return to live</button>}
    </div>
    <div className="chart-price-labels">
      <span>Latest observed BTC <strong>{fmtUsd(latest?.price)}</strong></span>
      {anchor!=null&&<span>WaterX price to beat <strong>{fmtUsd(anchor)}</strong></span>}
    </div>
    {samples.length ? <><div className="chart-measure">
       <svg ref={svgRef} className={`price-chart ${tone}`} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`Coinbase BTC comparison observations over ${activeWindowMode === "round" || activeWindowMode === "observed" ? "the active round through close" : `${activeWindowMode} minutes`}; gaps are not interpolated${anchor == null ? "" : "; dashed line is the current WaterX reported reference"}`}>
        <defs><linearGradient id="price-underlay" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" className="area-start" stopOpacity=".22" /><stop offset="100%" className="area-start" stopOpacity="0" /></linearGradient></defs>
         {anchor != null && <><rect x={left} y={top} width={plotRight - left} height={Math.max(0, y(anchor) - top)} className="reference-zone-above" /><rect x={left} y={y(anchor)} width={plotRight - left} height={Math.max(0, H - bottom - y(anchor))} className="reference-zone-below" /></>}
         {[0, .5, 1].map((f, i) => { const py = top + f * (H - top - bottom); const price = hi - f * (hi - lo); const axisPrice = width < 500 ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(price) : fmtUsd(price); return <g key={i}><line x1={left} x2={plotRight} y1={py} y2={py} className="gridline" /><text x={left - 7} y={py + 4} textAnchor="end" className="axis-label">{axisPrice}</text></g>; })}
         {axisTicks.map(tick=><line key={tick.at} x1={x(tick.at)} x2={x(tick.at)} y1={top} y2={H-bottom} className="time-tick" />)}
          {nowInside && <><rect x={nowX} y={top} width={Math.max(0, plotRight - nowX)} height={H - top - bottom} className="future-shade" /><line x1={nowX} x2={nowX} y1={top} y2={H - bottom} className="now-line" /><text x={nowLabelX} y={top + 13} textAnchor={nowLabelRightAligned ? "end" : "start"} className="now-label">NOW</text></>}
         {anchor != null && <line x1={left} x2={plotRight} y1={y(anchor)} y2={y(anchor)} className="anchor-line" />}
        {chunks.map((segment, idx) => <g key={idx}>
          {segment.length > 1 && <polygon points={`${x(Number(segment[0].at))},${H - bottom} ${segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} ${x(Number(segment.at(-1)!.at))},${H - bottom}`} className="price-area" />}
          {segment.length > 1 && <polyline points={segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} className="price-line" />}
        </g>)}
         {latest?.price != null && <g><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="8" className="latest-halo" /><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="4" className="latest-dot" /></g>}
        {active?.price != null && <g><line x1={x(Number(active.at))} x2={x(Number(active.at))} y1={top} y2={H - bottom} className="inspect-line" /><circle cx={x(Number(active.at))} cy={y(active.price)} r="5" className="inspect-point" /></g>}
        {startInside && <line x1={x(round!.startMs)} x2={x(round!.startMs)} y1={top} y2={H - bottom} className="round-boundary" />}
        {endInside && <line x1={x(round!.expiryMs)} x2={x(round!.expiryMs)} y1={top} y2={H - bottom} className="round-boundary" />}
        <rect x={left} y={top} width={plotRight - left} height={H - top - bottom} className="chart-hit" tabIndex={0} aria-label="Inspect chart observations with arrow keys" onPointerMove={e => selectAt(e.clientX)} onPointerDown={e => { if (e.pointerType === "touch") selectAt(e.clientX); }} onClick={e => selectAt(e.clientX)} onKeyDown={e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const index = active ? samples.findIndex(p => inspectedPointKey(p) === selectedKey) : samples.length - 1; const next = Math.min(samples.length - 1, Math.max(0, index + (e.key === "ArrowRight" ? 1 : -1))); setSelectedKey(inspectedPointKey(samples[next])); } }} />
      </svg>
    </div>
    <div className="chart-time-axis" aria-label="Observation time ticks" style={{marginLeft:left,marginRight:right}}>
      {axisTicks.map(tick=><time key={tick.at} dateTime={new Date(tick.at).toISOString()}
        style={{left:`${tick.fraction*100}%`,transform:tick.align==="left"?"none":tick.align==="right"?"translateX(-100%)":"translateX(-50%)"}}>{tick.label}</time>)}
    </div>
    <div className="chart-boundary-row" style={{paddingLeft:left,paddingRight:right}}>
      <span>{startInside?"START":""}</span><span>{endInside?"CLOSE":""}</span>
    </div><div className="chart-timezone">All chart times UTC</div>
    </> : <div className="chart-empty"><Activity size={22} /><strong>No comparison samples in this window</strong><span>Waiting for archived points or a live Coinbase event. Missing observations are not interpolated.</span></div>}
    {active && <div className="sample-inspector" aria-live="polite"><span>INSPECTED OBSERVATION</span><b>{fmtUsd(active.price)}</b><small>{utc(Number(active.at))} · {active.source || "Coinbase"} · event age {ago(active.sourceAt ?? Number(active.at))}</small></div>}
    {points.some(p => p.gap || p.price == null) && <div className="gap-caption">Feed gaps remain blank; no price is inferred. {streamStatus !== "LIVE" && "Live feed reconnecting."}</div>}
  </div>;
}

function HistoryPage() {
  const [interval, setInterval] = useIntervalPreference();
  const [historySource, setHistorySource] = useState<HistorySource>("baseline");
  const url = `/api/waterx/history?interval=${interval}&source=${historySource}`;
  const result = useApi<{ rows?: Record<string, unknown>[] }>(url, 30000);
  const intervalResponseReady = result.loadedUrl === url;
  const rows = intervalResponseReady ? result.data?.rows ?? [] : [];
  return <div className="page inner-page">
    <PageTitle index="02" title="Round history"><div className="heading-right"><label className="history-source-select">HISTORY SOURCE<select value={historySource} onChange={event => setHistorySource(event.target.value as HistorySource)}><option value="baseline">WaterX market baseline</option><option value="bluewater">Bluewater champion</option><option value="fallback">Deterministic 50/50 fallback · research-only</option></select></label><span className="muted-label">MARKET DURATION</span><IntervalSwitch value={interval} onChange={setInterval} /></div></PageTitle>
    <div className="intro-line"><p>Recorded WaterX rounds and their reported reference prices. Each interval is a different market duration.</p><span>{historySourceLabel(historySource)} · {rows.length} rows</span></div>
    {historySource === "fallback" && <div className="history-note"><ShieldAlert size={15} /> Deterministic 50/50 tie-break evidence only · low-confidence research cohort, isolated from baseline and champion denominators. No trade, return, or P&amp;L inference.</div>}
    {result.error && result.errorUrl === url ? <ErrorBox message={result.error} retry={result.reload} /> : !intervalResponseReady ? <Skeleton height={330} /> :
      rows.length ? <div className="table-frame"><table><thead><tr><th>Round</th><th>Start · UTC</th><th>Close · UTC</th><th>Price to beat</th><th>Settlement</th><th>Outcome</th><th>Evidence</th><th>Market UP at capture</th></tr></thead><tbody>{rows.map((r, i) => {
        const id = String(r.roundId ?? `round-${i}`);
        const started = r.startMs;
        const ended = r.expiryMs;
        const anchor = typeof r.anchorPrice === "number" ? r.anchorPrice : null;
        const evidence = r.evidence && typeof r.evidence === "object" ? r.evidence as Record<string, unknown> : {};
        const tieBreakApplied = evidence.tieBreakApplied === true;
        const evidenceLabel = tieBreakApplied ? "50/50 tie-break · research-only"
          : historySource === "fallback" ? "Fallback cohort · tie-break evidence unavailable"
            : String(r.labelStatus ?? "unresolved");
        return <tr key={id}><td className="mono-cell" title={id}>{id.slice(0, 8)}…</td><td>{utc(typeof started === "number" ? started : undefined)}</td><td>{utc(typeof ended === "number" ? ended : undefined)}</td><td>{fmtUsd(anchor)}{r.anchorConfirmed !== true && <small> · pending confirmation</small>}</td><td>{fmtUsd(typeof r.settlePrice === "number" ? r.settlePrice : null)}</td><td><span className={`outcome ${String(r.outcome ?? "").toLowerCase()}`}>{String(r.outcome ?? "Unresolved")}</span></td><td title={typeof r.withheldReason === "string" ? r.withheldReason : undefined}>{evidenceLabel}</td><td>{typeof r.probabilityUp === "number" ? `${(r.probabilityUp * 100).toFixed(1)}%` : "Not captured"}</td></tr>;
      })}</tbody></table></div> : <div className="empty-state"><Clock3 size={22} /><strong>No recorded rounds returned</strong><span>History is shown only when the WaterX archive has recorded rows. No examples are fabricated.</span></div>}
    <div className="history-note"><ShieldCheck size={15} /> These are observed records, not a performance claim or trading recommendation.</div>
  </div>;
}

function LearningPage() {
  const [interval, setInterval] = useIntervalPreference();
  const [operationsSource, setOperationsSource] = useState<HistorySource>("baseline");
  const [operationsWindow, setOperationsWindow] = useState("lifetime");
  const url = `/api/waterx/model?interval=${interval}`;
  const result = useApi<Record<string, unknown>>(url, 60000);
  const researchUrl = `/api/waterx/research?interval=${interval}`;
  const research = useApi<ResearchReport>(researchUrl, 60000);
  const bluewaterUrl = `/api/waterx/bluewater?interval=${interval}`;
  const bluewater = useApi<BluewaterReport>(bluewaterUrl, 60000);
  const operationsUrl = `/api/waterx/research-operations?interval=${interval}&window=${operationsWindow}&source=${operationsSource}`;
  const operations = useApi<ResearchOperations>(operationsUrl, 60000);
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
  const prospectiveCapture = asRecord(candidate?.prospectiveCapture);
  const prospectiveSnapshotCount = typeof prospectiveCapture?.snapshotCount === "number"
    ? prospectiveCapture.snapshotCount : null;
  const captureWarning = prospectiveSnapshotCount == null
    ? "Prospective capture count is not reported; the current gate and historical skip reason are unknown."
    : prospectiveSnapshotCount === 0
      ? "No prospective snapshots are stored. Per-round historical skip reasons were not retained."
      : null;
  const captureGates = Array.isArray(prospectiveCapture?.requiredGates)
    ? prospectiveCapture.requiredGates.filter((gate): gate is string => typeof gate === "string") : [];
  const candidateTest = asRecord(candidate?.candidateTestMetrics);
  const candidateMarket = asRecord(candidate?.matchingMarketTestMetrics);
  const lastSettlement = asRecord(candidate?.lastAcceptedSettlement);
  const forward = asRecord(candidate?.forwardPredictionEvaluation);
  const forwardVersions = Array.isArray(forward?.byModelVersion) ? forward.byModelVersion.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
  const trainingAttempt = typeof candidate?.lastTrainingAttempt === "string" ? candidate.lastTrainingAttempt : null;
  const trainingOutcome = typeof candidate?.lastTrainingOutcome === "string" ? candidate.lastTrainingOutcome : "Not reported";
  const candidateVersion = typeof candidate?.candidateModelVersion === "string" ? candidate.candidateModelVersion : "None persisted";
  const calibrationVersion = typeof candidate?.calibrationVersion === "string" ? candidate.calibrationVersion : "None persisted";
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
    <EarlyLearningSummary interval={interval} />
    <EarlyLearningJobsPanel />
    <BluewaterResearchPanel
      report={bluewater.loadedUrl === bluewaterUrl && bluewater.data?.intervalMinutes === interval ? bluewater.data : null}
      interval={interval}
      loading={bluewater.loading}
      error={bluewater.error && bluewater.errorUrl === bluewaterUrl ? bluewater.error : ""}
      retry={bluewater.reload}
    />
    <ResearchLearningPanel
      report={research.loadedUrl === researchUrl && research.data?.intervalMinutes === interval ? research.data : null}
      interval={interval}
      loading={research.loading}
      error={research.error && research.errorUrl === researchUrl ? research.error : ""}
      retry={research.reload}
    />
      <p className="research-shadow-boundary">Early signal observations remain shadow-only. No verified executable deadline has been measured, so no order-ready countdown or deadline is asserted.</p>
      <section className="research-operations-panel">
        <div className="learning-section-heading">
          <div><div className="eyebrow">READ-ONLY RESEARCH OPERATIONS</div><h2>Capture & learning status</h2></div>
          <span>{interval}m · {operationsWindow} · {historySourceLabel(operationsSource)}</span>
        </div>
        <p className="research-operations-note">Operational timestamps and cohort summary use the same selected source, interval, and window denominators. The 50/50 fallback is an isolated low-confidence research cohort selected only through its tie-break evidence; it does not modify baseline or champion results and implies no trade or P&amp;L.</p>
        <div className="research-operations-filters">
          <label>History source<select value={operationsSource} onChange={event => setOperationsSource(event.target.value as HistorySource)}><option value="baseline">WaterX market baseline</option><option value="bluewater">Bluewater champion</option><option value="fallback">Deterministic 50/50 fallback · research-only</option></select></label>
          <label>History window<select value={operationsWindow} onChange={event => setOperationsWindow(event.target.value)}>{[["lifetime","Lifetime"],["100","Last 100"],["50","Last 50"],["20","Last 20"],["24h","24 hours"],["7d","7 days"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        {operations.error && operations.loadedUrl !== operationsUrl ? <div className="research-operations-state" role="alert"><strong>Research operations unavailable</strong><span>{operations.error}</span><button className="quiet-button" onClick={operations.reload}>Retry</button></div>
          : !operations.data || operations.loadedUrl !== operationsUrl ? <div className="research-operations-skeleton" role="status">Loading selected cohort operations…</div>
            : <>
              {operations.error && operations.loadedUrl === operationsUrl && <div className="research-operations-refresh-warning" role="status">Refresh failed; showing the last successfully loaded operations report for this selected cohort. <button className="quiet-button" onClick={operations.reload}>Retry</button></div>}
              <p className="research-operations-asof">API cohort · {operations.data.cohort.intervalMinutes}m · {operations.data.cohort.window} · {historySourceLabel(operations.data.cohort.source)} · as of {new Date(operations.data.asOfMs).toLocaleString()}</p>
              <div className="research-operations-summary">
                {([["Correct",operations.data.summary.correct],["Incorrect",operations.data.summary.incorrect],["Pending",operations.data.summary.pending],["Withdrawn / disputed",operations.data.summary.withdrawn],["No choice",operations.data.summary.noChoice],["Scored",operations.data.summary.scored],["Correct : incorrect",operations.data.summary.ratio],["Hit rate",fmtProbability(operations.data.summary.hitRate)],["Choice coverage",fmtProbability(operations.data.summary.coverage)],["Cohort rounds",operations.data.summary.total]] as [string,string | number][]).map(([label,value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
              </div>
              <div className="research-operations-grid">
                {([["Last successful capture",operations.data.operations.lastCaptureAt],["Last training",operations.data.operations.lastTrainingAt],["Last calibration",operations.data.operations.lastCalibrationAt],["Last evaluation",operations.data.operations.lastEvaluationAt],["Last candidate",operations.data.operations.lastCandidateAt],["Last promotion",operations.data.operations.lastPromotionAt]] as [string,string | null][]).map(([label,value]) => <div key={label}><span>{label}</span><b>{value ? utc(value) : "No successful run reported"}</b></div>)}
                <div><span>Training count</span><b>{operations.data.operations.trainingCount}</b></div>
                <div><span>Daily job</span><b>{operations.data.dailyJob.status} · {operations.data.dailyJob.mode}</b></div>
              </div>
              <div className="research-operations-blockers"><strong>Current blockers</strong>{operations.data.operations.blockers.length ? <ul>{operations.data.operations.blockers.map((blocker,index) => <li key={`${blocker}:${index}`}>{blocker}</li>)}</ul> : <p>No blockers reported by this endpoint; this is not evidence of promotion or execution readiness.</p>}</div>
              <details className="research-operations-definitions"><summary>Denominator, job and definition details</summary>
                <p><b>History:</b> {operations.data.definitions.history}</p><p><b>Training:</b> {operations.data.definitions.training}</p>
                <p><b>Daily job:</b> {operations.data.dailyJob.configured ? "Configured" : "Not configured"} · {operations.data.dailyJob.guaranteesDailyExecution ? "daily guarantee reported" : "no daily execution guarantee"} · started {operations.data.dailyJob.startedAt ? utc(operations.data.dailyJob.startedAt) : "not reported"} · finished {operations.data.dailyJob.finishedAt ? utc(operations.data.dailyJob.finishedAt) : "not reported"}</p>
                {operations.data.dailyJob.error && <p><b>Last job error:</b> {operations.data.dailyJob.error}</p>}
                {operations.data.dailyJob.reason && <p><b>Job status reason:</b> {operations.data.dailyJob.reason}</p>}
              </details>
            </>}
      </section>
    {result.error && result.errorUrl === url ? <ErrorBox message={result.error} retry={result.reload} /> : !intervalResponseReady ? <Skeleton height={360} /> : <>
      <section className={`learning-status ${ready ? "ready" : "not-ready"}`}>
        <div><span className="eyebrow">{interval}-MINUTE MARKET COHORT</span><strong>{ready ? "Readiness gates met" : status === "insufficient" ? "More verified history needed" : status.replace(/[_-]/g, " ")}</strong>
          <p>{ready ? "Eligibility gates are met for this interval. Metrics below appear only when the service has actually scored them." : `Readiness is interval-specific. This ${interval}-minute cohort is not currently eligible for a promoted forecast.`}</p>
        </div><span className={`readiness-badge ${ready ? "pass" : ""}`}>{ready ? "READY" : "BUILDING EVIDENCE"}</span>
      </section>

      <section className="readiness-panel">
        <div className="learning-section-heading"><div><div className="eyebrow">LEGACY FITTED-BASELINE AUDIT</div><h2>Prior confirmed-only baseline state</h2></div><span>{interval}m only</span></div>
        <p className="legacy-candidate-note">This existing model endpoint describes the prior fitted baseline and confirmed-reference capture path. It does not report the prospective round-choice ledger or the new bounded daily shadow evaluation above.</p>
        <div className="readiness-grid">
          <article><span>LAST ACCEPTED SETTLEMENT</span><strong>{typeof lastSettlement?.settledAt === "number" ? utc(lastSettlement.settledAt) : "Not reported"}</strong><small>{typeof lastSettlement?.outcome === "string" ? `${lastSettlement.outcome} · verified label` : "No accepted result reported"}</small></article>
          <article><span>LAST TRAINING ATTEMPT</span><strong>{trainingAttempt ? utc(trainingAttempt) : "None reported"}</strong><small>{trainingOutcome} · manual/offline; not an automatic per-round job</small></article>
          <article><span>MODEL / CALIBRATION</span><strong>{candidateVersion}</strong><small>Calibration: {calibrationVersion} · artifact {candidate?.modelArtifactPersisted === true ? "persisted" : "not persisted"}</small></article>
          <article><span>FORWARD EVALUATION</span><strong>{typeof forward?.scoredPredictionCount === "number" ? forward.scoredPredictionCount : "—"} scored</strong><small>{typeof forward?.storedPredictionCount === "number" ? forward.storedPredictionCount : "—"} stored prospective predictions · matched WaterX comparison {forwardVersions.some(row => asRecord(row.matchingMarketMetrics)) ? "reported below" : "not scored"}</small></article>
        </div>
        {forwardVersions.map((row, index) => <div className="label-integrity" key={String(row.modelVersion ?? index)}>
          <span>{String(row.modelVersion ?? "Unversioned candidate")} · {typeof row.scoredPredictionCount === "number" ? row.scoredPredictionCount : "—"} matched scored predictions</span>
          <span>Candidate Brier: {fmtMetric(metricValue(asRecord(row.candidateMetrics), ["brier"]))}</span>
          <span>WaterX market Brier: {fmtMetric(metricValue(asRecord(row.matchingMarketMetrics), ["brier"]))}</span>
        </div>)}
        {captureWarning && <div className="capture-warning"><ShieldAlert size={14} /><span>{captureWarning}</span></div>}
        <details className="capture-details">
          <summary><span>Prospective snapshot capture · {prospectiveSnapshotCount == null ? "not reported" : `${prospectiveSnapshotCount} stored`}</span><ChevronDown size={14} /></summary>
          <div className="capture-details-body">
            <span>Capture status</span><b>{typeof prospectiveCapture?.status === "string" ? prospectiveCapture.status : "Not reported by this API"}</b>
            <span>Snapshot gate</span><b>{typeof prospectiveCapture?.blockingReason === "string" ? prospectiveCapture.blockingReason : "No blocking reason reported."}</b>
            {prospectiveSnapshotCount === 0 && <><span>Historical blocker</span><b>Unknown: the per-round capture skip reason was not retained.</b></>}
            {prospectiveSnapshotCount == null && <><span>Historical blocker</span><b>Not reported: snapshot count and per-round skip reason are unavailable.</b></>}
            <span>Required gates</span><ul>{captureGates.length ? captureGates.map(gate => <li key={gate}>{gate}</li>) : <li>None reported.</li>}</ul>
            <span>Next evidence</span><b>{typeof prospectiveCapture?.nextEvidence === "string" ? prospectiveCapture.nextEvidence : "Not reported."}</b>
          </div>
        </details>
        <div className="cohort-outcome"><span className="cohort-dot" /><p>Promotion: {typeof candidate?.promotionStatus === "string" ? candidate.promotionStatus : "not reported"}. {typeof candidate?.promotionRejectionReason === "string" ? candidate.promotionRejectionReason : "No promotion decision reported."} Training, calibration, and forward evaluation are separate; settlement alone does not imply improvement.</p></div>
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
        <div className="learning-section-heading"><div><div className="eyebrow">LEGACY CONFIRMED-ONLY CANDIDATE AUDIT</div><h2>Prior candidate artifacts</h2></div><span>{typeof candidate?.status === "string" ? candidate.status.replace(/-/g, " ") : "unavailable"}</span></div>
        <p className="legacy-candidate-note">This older confirmed-reference candidate audit is separate from the prospective checkpoint choice ledger and bounded daily research job above. Its capture/training counts do not describe current research choices.</p>
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
      <div className="learning-foot"><ShieldCheck size={15} /> An insufficient cohort is not a negative performance result. The live desk remains market-observation only; model reliability is unrated.</div>
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
  const refreshHealthUrl = `/api/waterx/refresh-health?interval=${interval}`;
  const live = useApi<LivePayload>(liveUrl, 5000);
  const chart = useApi<ChartPayload>(chartUrl, 30000);
  const version = useApi<Record<string, unknown>>(versionUrl, 60000);
  const collector = useApi<Record<string, unknown>>(collectorUrl, 15000);
  const latency = useApi<Record<string, unknown>>(latencyUrl, 30000);
  const refreshHealth = useApi<RefreshHealthReport>(refreshHealthUrl, 5000);
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
  const refreshHealthInfo = !refreshHealth.error && refreshHealth.loadedUrl === refreshHealthUrl
    ? refreshHealth.data : null;
  const refreshOperations = refreshHealthInfo?.refreshHealth ?? null;
  const stageErrors = refreshOperations?.errors ?? [];
  const refreshAlerts = refreshOperations?.alerts ?? [];
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
  const referenceAvailability = snapshot?.availability?.referencePrice;
  const referenceValid = roundCurrent && referenceAvailability?.status !== "unavailable" &&
    typeof round?.referencePrice === "number" && Number.isFinite(round.referencePrice) && round.referencePrice > 0;
  const oddsAge = snapshot?.odds?.asOf ? serverNow - Date.parse(snapshot.odds.asOf) : Infinity;
  const oddsAvailability = snapshot?.availability?.odds;
  const oddsAvailabilityStatus = oddsAvailability?.status;
  const oddsCurrent = !!(roundCurrent && snapshot?.odds && isWaterxMarketSource(snapshot.odds.source) &&
    oddsAvailabilityStatus !== "unavailable" && oddsAvailabilityStatus !== "locked" &&
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
    <section className="panel latency-panel refresh-health-panel" aria-label="Process-local refresh health">
      <div className="section-head">
        <div><div className="eyebrow">PROCESS-LOCAL · NO DATABASE READ</div><h2>Refresh stage health</h2></div>
        <button className="quiet-button" onClick={refreshHealth.reload}><RefreshCw size={14} /> Refresh</button>
      </div>
      {refreshHealth.error && refreshHealth.errorUrl === refreshHealthUrl
        ? <div className="latency-unavailable"><span>Refresh-stage telemetry unavailable.</span><button className="text-button" onClick={refreshHealth.reload}>Retry</button></div>
        : !refreshHealthInfo ? <Skeleton height={82} />
          : <>
            <div className="health-details">
              <div><span>Scope</span><b>{refreshOperations?.scope ?? "Not reported"}</b></div>
              <div><span>Recent events</span><b>{refreshOperations?.events?.length ?? 0}</b></div>
              <div><span>Capture queues</span><b>{Array.isArray(refreshHealthInfo.captureQueues)
                ? `${refreshHealthInfo.captureQueues.length} queue records`
                : refreshHealthInfo.captureQueues && typeof refreshHealthInfo.captureQueues === "object"
                  ? `${Object.keys(refreshHealthInfo.captureQueues as Record<string, unknown>).length} queue groups`
                  : "Not reported"}</b></div>
            </div>
            {refreshAlerts.map((alert, index) => <p className="health-warning" role="status" key={`alert-${index}`}>{alert}</p>)}
            {stageErrors.length > 0
              ? <div className="health-details refresh-stage-errors">{stageErrors.map((entry, index) =>
                <div key={`${entry.stage}-${index}`}><span>{entry.stage} · {entry.failures} failures</span><b>{entry.lastErrorClass ?? "Error class unknown"}</b><small>{entry.atMs == null ? "Time not reported" : utc(entry.atMs)}</small></div>)}</div>
              : <p className="latency-context" role="status">No recent refresh-stage errors reported.</p>}
          </>}
      <p className="latency-context">Operational telemetry is process-memory only. It is not durable coverage, proof of a persisted round, or trade evidence.</p>
    </section>
    {live.error && live.errorUrl === liveUrl && !liveMatchesInterval ? <ErrorBox message={live.error} retry={live.reload} /> : !liveMatchesInterval && live.loading ? <Skeleton height={220} /> : <>
       <div className="health-status"><span className={`health-signal ${roundCurrent && snapshot?.status === "LIVE" ? "ok" : "warn"}`}><i /> {status}</span><small>API snapshot {snapshotCurrent ? utc(snapshot?.serverTime) : "not current"}</small></div>
       {snapshotCurrent && !roundCurrent && typeof snapshot?.reason === "string" && <p className="health-warning">WaterX round withheld: {snapshot.reason}</p>}
      <section className="provenance-grid">
         <article><span className="source-number">01</span><div className="eyebrow">WATERX BEGINNING REFERENCE</div><h2>Price to beat</h2><strong>{referenceValid ? fmtUsd(round?.referencePrice) : "Withheld"}</strong><p>{referenceValid ? `Reported by WaterX. ${referenceAvailability?.status === "provisional" || !round?.anchorConfirmed ? "Provisional; confirmation pending." : "Reference confirmation is reported."}` : referenceAvailability?.reason || "No positive active-round reference is available."}</p><small>Settlement source: Chainlink BTC/USD TWAP · round {round?.id || "not currently verified"}</small></article>
        <article><span className="source-number">02</span><div className="eyebrow">MARKET PRICES</div><h2>WaterX odds</h2><strong>{oddsAvailabilityStatus === "unavailable" ? "Odds temporarily unavailable" : oddsAvailabilityStatus === "locked" ? "Locked" : oddsCurrent && snapshot?.odds ? `${fmtOdds(snapshot.odds.upPriceCents)} / ${fmtOdds(snapshot.odds.downPriceCents)}` : "Withheld"}</strong><p>{oddsCurrent && snapshot?.odds ? `Source ${snapshot.odds.source} · ${ago(snapshot.odds.asOf)}. Market probabilities, not model forecasts.` : oddsAvailability?.reason || "No fresh WaterX odds for the active round."}</p><small>Interval {interval} minutes · prices not executable</small></article>
        <article><span className="source-number">03</span><div className="eyebrow">COMPARISON ONLY</div><h2>Coinbase live feed</h2><strong>{comparisonCurrent && snapshot?.comparison ? fmtUsd(snapshot.comparison.price) : "Withheld"}</strong><p>{comparisonCurrent && snapshot?.comparison ? `Source ${snapshot.comparison.source} · ${ago(snapshot.comparison.asOf)}. Never used for settlement.` : "No fresh Coinbase comparison for the active round."}</p><small>Separate from the Chainlink settlement TWAP</small></article>
      </section>
       <section className="panel chart-health"><div className="section-head"><div><div className="eyebrow">OBSERVATION ARCHIVE</div><h2>Chart data availability</h2></div><button className="quiet-button" onClick={chart.reload}><RefreshCw size={14} /> Refresh</button></div>
         {chart.error && chart.errorUrl === chartUrl ? <p className="health-warning">{chart.error}</p> : !chartMatchesInterval ? <Skeleton height={125} /> : <div className="health-details"><div><span>Archive source</span><b>{chartSnapshot?.source ?? "Not reported"}</b></div><div><span>Window</span><b>{chartSnapshot?.windowMinutes ?? interval} minutes</b></div><div><span>Returned points</span><b>{chartSnapshot?.coverage?.observedPointCount ?? chartSnapshot?.points?.length ?? 0}</b></div><div><span>Coverage status</span><b>{chartSnapshot?.coverage?.status ?? (chartSnapshot?.coverage?.partial ? "partial" : "Not reported")}</b></div><div><span>Observation span</span><b>{durationLabel(chartSnapshot?.coverage?.observationSpanMs)}</b></div><div><span>Initial missing duration</span><b>{durationLabel(chartSnapshot?.coverage?.missingStartMs)}</b></div><div><span>Interior gaps</span><b>{chartSnapshot?.coverage?.gapCount ?? "Not reported"}</b></div><div><span>Round phase</span><b>{round?.phase ?? "Unavailable"}</b></div><div><span>Reference</span><b>{referenceValid ? referenceAvailability?.status === "provisional" || !round?.anchorConfirmed ? "Provisional" : "Confirmed" : "Unavailable"}</b></div><div><span>Market interval</span><b>{snapshotCurrent ? `${snapshot?.intervalMinutes}m` : "Unavailable"}</b></div></div>}
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
          <div><span>Last successful WaterX request</span><b>{String(collectorDetails.lastSuccessfulRequestAt ?? "Not reported")}</b></div>
          <div><span>Last valid WaterX round</span><b>{String(collectorDetails.lastValidRoundId ?? "Not reported")}</b></div>
          <div><span>Provider source timestamp</span><b>{String(collectorDetails.providerSourceTimestamp ?? "Not supplied · response ages are app-observed")}</b></div>
          <div><span>Failure stage / retry attempt</span><b>{String(collectorDetails.lastFailureStage ?? "None reported")} / {String(collectorDetails.retryAttempt ?? "Not reported")}</b></div>
          <div><span>Last rejection reason</span><b>{String(collectorDetails.lastRejectionReason ?? "None reported")}</b></div>
          <div><span>Last prospective capture result</span><b>{String(collectorDetails.lastCandidateCaptureReason ?? "Unknown · process-local reasons only")}</b></div>
          <div><span>Packaged release source</span><b><a href="/source-release.tar.gz">Download this release’s source</a> · build and per-file hashes included</b></div>
          <div><span>{interval}m backlog</span><b>{String(intervalBacklog ?? "Not reported")}</b></div>
          <div><span>Health endpoint scope</span><b>WaterX · {interval}m selected</b></div>
        </div>
        {(version.error || collector.error) && <div className="reference-absent">Some diagnostics could not be loaded. This does not change live desk qualification.</div>}
        <div className="chart-foot"><button className="text-button" onClick={() => { version.reload(); collector.reload(); }}>Refresh diagnostics</button><span>Build and collector fields are informational only.</span></div>
      </details>
       <div className="health-warning"><ShieldCheck size={16} /><p><b>Evidence scope:</b> stale values, expired rounds, interval mismatches, and source mismatches are withheld. Market odds are observational only; model reliability is unrated and no trade action exists.</p></div>
      <div className="live-bottom"><button className="quiet-button" onClick={() => { live.reload(); chart.reload(); }}><RefreshCw size={14} /> Refresh health</button><Link href="/" className="inline-link">Return to live desk</Link></div>
    </>}
  </div>;
}

export default function App() {
  return <Shell><Switch>
    <Route path="/" component={LivePage} />
    <Route path="/history" component={CanonicalHistory} />
    <Route path="/learn" component={LearningPage} />
    <Route path="/health" component={HealthPage} />
    <Route path="/agent" component={AgentPage} />
    <Route><div className="page not-found"><div className="eyebrow">NO SUCH VIEW</div><h1>This page isn't on the desk.</h1><Link href="/" className="inline-link">Back to live desk</Link></div></Route>
  </Switch></Shell>;
}