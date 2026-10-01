import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { Activity, BookOpen, ChevronDown, CircleHelp, Clock3, Database, ExternalLink, Menu, RefreshCw, ShieldAlert, ShieldCheck, Waves, X } from "lucide-react";
import { inspectedPointKey, pointerTimestamp } from "./chart-contract";
import { insertTimestampGaps, isActiveWaterxRound, isCoinbaseSource, isFreshWaterxSnapshot, isWaterxMarketSource, resetSseCursor, selectWaterxOddsDisplay, selectWaterxPriceDistance, selectWaterxReference, sseReconnectUrl } from "./waterx-ui-contract";
import { mergeComparisonPoints } from "./chart-contract";
import { browserRenderSummary, recordBrowserRender } from "./browser-latency";
import { AdvisoryCards } from "./AdvisoryCards";
import { type AdvisoryPayload } from "./advisory-contract";

type Interval = 5 | 15;
type Point = { at: number | string; price: number | null; source?: string; sourceAt?: number | string | null; eventId?: string | number; gap?: boolean; reason?: string };
type SideAvailability = { probability?: string; price?: string; pricePositive?: boolean; executable?: false; side?: string; reason?: string | null };
type OddsAvailability = { status?: "available" | "partial" | "locked" | "unavailable" | string; reason?: string | null; up?: SideAvailability; down?: SideAvailability };
type Availability = { roundMetadata?: { status?: string; reason?: string | null }; referencePrice?: { status?: string; reason?: string | null }; odds?: OddsAvailability; comparisonPrice?: { status?: string; reason?: string | null } };
type LivePayload = {
  serverTime?: string; status?: string; intervalMinutes?: number; reason?: string;
  round?: { id: string; marketId?: string; startMs: number; expiryMs: number; referencePrice: number | null; anchorConfirmed: boolean; phase?: string; url?: string } | null;
  odds?: { up: number | null; down: number | null; upPriceCents: number | null; downPriceCents: number | null; asOf: string; source: string } | null;
  comparison?: { price: number; asOf: string; source: string } | null;
  availability?: Availability;
  learning?: Record<string, unknown>;
  advisory?: AdvisoryPayload & { amountEnteredUsd?: number };
};
type ChartCoverage = { startMs?: number; endMs?: number; expectedSamples?: number; observedSamples?: number; percent?: number; partial?: boolean; status?: string; reason?: string; observationSpanMs?: number; requestedDurationMs?: number; missingStartMs?: number | null; missingEndMs?: number | null; gapCount?: number; observedPointCount?: number; measurement?: string };
type ChartPayload = { windowMinutes: number; source: string; points: Point[]; coverage?: ChartCoverage };
type WaterxHealth = { collector?: { lastValidObservationAt?: string | null; lastError?: string | null } };

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
  const [chartWindow, setChartWindow] = useState<"observed" | "round" | 5 | 15>("observed");
  const [now, setNow] = useState(Date.now());
  const rolloverSince = useRef<number | null>(null);
  const fixtureNames = ["high-likelihood-up", "high-likelihood-down", "favorable-risk-reward-up", "favorable-risk-reward-down", "wait", "unvalidated", "stale-quote", "collector-stalled", "rollover", "too-late", "locked"] as const;
  const requestedFixture = new URLSearchParams(window.location.search).get("fixture");
  const fixtureMode = import.meta.env.DEV && fixtureNames.includes(requestedFixture as typeof fixtureNames[number])
    ? requestedFixture as typeof fixtureNames[number] : null;
  const liveUrl = `/api/waterx/advisory?interval=${interval}&amount=5`;
  const chartUrl = `/api/waterx/chart?interval=${interval}&window=${chartWindow === "round" || chartWindow === "observed" ? interval : chartWindow}`;
  const learningUrl = `/api/waterx/model?interval=${interval}`;
  const healthUrl = `/api/waterx/health?interval=${interval}`;
  const live = useApi<LivePayload>(liveUrl, 3000, !fixtureMode);
  const chart = useApi<ChartPayload>(chartUrl, 30000, !fixtureMode);
  const learning = useApi<Record<string, unknown>>(learningUrl, 60000, !fixtureMode);
  const health = useApi<WaterxHealth>(healthUrl, 10000, !fixtureMode);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const fixtureNow = now;
  const fixtureStart = useMemo(() => Date.now() - 60_000, [interval, fixtureMode]);
  const fixtureRound = fixtureMode === "rollover" || fixtureMode === "collector-stalled" ? null : {
    id: `DEV-FIXTURE-${interval}-${fixtureStart}`,
    marketId: `DEV-MARKET-${interval}`,
    startMs: fixtureMode === "too-late" ? fixtureStart - interval * 60_000 : fixtureStart,
    expiryMs: fixtureMode === "too-late" ? fixtureNow - 1 : fixtureStart + interval * 60_000,
    referencePrice: 83642.18, anchorConfirmed: true, phase: "ROUND IN PROGRESS",
  };
  const fixturePayload: LivePayload | null = fixtureMode ? fixtureMode === "rollover" ? {
    serverTime: new Date(fixtureNow).toISOString(), status: "COLLECTION_DELAYED", intervalMinutes: interval,
    reason: "Fixture: active round discovery is delayed beyond the normal rollover window.", round: null,
    odds: null, comparison: { price: 83671.42, asOf: new Date(fixtureNow).toISOString(), source: "Coinbase (fixture)" },
  } : {
    serverTime: new Date(fixtureNow).toISOString(),
    status: fixtureMode === "collector-stalled" ? "COLLECTION_DELAYED" : "LIVE", intervalMinutes: interval, round: fixtureRound,
    odds: fixtureMode === "stale-quote" || fixtureMode === "collector-stalled" ? null : {
      up: .583, down: .417,
      upPriceCents: fixtureMode === "locked" ? 0 : 58, downPriceCents: fixtureMode === "locked" ? 0 : 42,
      asOf: new Date(fixtureNow).toISOString(), source: "WaterX (fixture)",
    },
    comparison: { price: 83671.42, asOf: new Date(fixtureNow).toISOString(), source: "Coinbase (fixture)" },
    availability: { referencePrice: { status: "available" }, odds: fixtureMode === "stale-quote" ? { status: "unavailable", reason: "Fixture: $5 quote is stale." } : fixtureMode === "collector-stalled" ? { status: "unavailable", reason: "Fixture: market snapshot is stale." } : fixtureMode === "locked" ? { status: "locked", up: { side: "locked" }, down: { side: "locked" } } : { status: "available" } },
  } : null;
  // Keep the selected interval internally consistent; freshness gates withhold
  // responses that arrive for a different market cadence.
  const payload = fixtureMode ? fixturePayload
    : live.data?.intervalMinutes === interval ? live.data : null;
  const round = payload?.round ?? null;
  const expectedAdvisoryIdentity = round?.marketId ? {
    marketId: round.marketId, roundId: round.id, intervalMinutes: interval,
    startMs: round.startMs, expiryMs: round.expiryMs,
  } : null;
  const serverMs = payload?.serverTime ? Date.parse(payload.serverTime) : NaN;
  const serverNow = fixtureMode ? now : Number.isFinite(serverMs) ? now + (serverMs - live.updated) : now;
  const snapshotToleranceMs = interval === 5 ? 16_000 : 31_000;
  const snapshotCurrent = !!fixtureMode || (!live.error && live.loadedUrl === liveUrl &&
    isFreshWaterxSnapshot(live.updated, payload?.serverTime, now, snapshotToleranceMs) &&
    payload?.intervalMinutes === interval);
  const roundCurrent = snapshotCurrent && !!round && isActiveWaterxRound(payload?.intervalMinutes, interval, round.startMs, round.expiryMs, serverNow);
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
  const odds = payload?.odds;
  const oddsAvailability = payload?.availability?.odds;
  const oddsDisplay = selectWaterxOddsDisplay({
    snapshotCurrent,
    roundCurrent,
    requestedInterval: interval,
    responseInterval: payload?.intervalMinutes,
    roundId: round?.id,
    roundStartMs: round?.startMs,
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
  const advisory = !fixtureMode && live.loadedUrl === liveUrl ? payload?.advisory : null;
  const matchedAdvisory = roundCurrent && !!expectedAdvisoryIdentity &&
    advisory?.identity?.marketId === expectedAdvisoryIdentity.marketId &&
    advisory?.identity?.roundId === round?.id &&
    advisory?.identity?.intervalMinutes === expectedAdvisoryIdentity.intervalMinutes &&
    advisory?.identity?.startMs === expectedAdvisoryIdentity.startMs &&
    advisory?.identity?.expiryMs === expectedAdvisoryIdentity.expiryMs &&
    advisory?.amountEnteredUsd === 5 ? advisory : null;
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
  const remaining = round ? timeRemaining(round.expiryMs, serverNow) : "—";
  const priceDistance = selectWaterxPriceDistance({
    referencePrice: waterxReference,
    comparisonFresh,
    comparisonPrice: comparison?.price,
    comparisonAtMs: comparisonMs,
    roundStartMs: round?.startMs,
  });
  const priceDelta = priceDistance?.distance ?? null;
  const priceDeltaPct = priceDistance?.percent ?? null;
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
  }, [fixtureMode]);
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

  const refreshAll = () => { live.reload(); chart.reload(); learning.reload(); };
  return <div className="page live-page">
      <div className="desk-toolbar">
      <div className="desk-market"><span className="eyebrow">WATERX / BTC · {interval} MIN</span><strong className={roundCurrent ? "desk-state" : "desk-state caution"}>{deskState}</strong></div>
      <div className="heading-right"><span className="sync-label"><i />{live.error && live.errorUrl === liveUrl ? "SYNC DELAYED" : "AUTO-REFRESH · 3 SEC"}</span><IntervalSwitch value={interval} onChange={setInterval} /></div>
    </div>
    {import.meta.env.DEV && <div className="fixture-banner fixture-picker">
      <label htmlFor="advisory-fixture">DEVELOPMENT-ONLY FIXTURES <span>not live WaterX data</span></label>
      <select id="advisory-fixture" value={fixtureMode || ""} onChange={event => {
        const value = event.target.value;
        window.location.href = value ? `${window.location.pathname}?fixture=${encodeURIComponent(value)}` : window.location.pathname;
      }}>
        <option value="">Live API response</option>
        {fixtureNames.map(name => <option key={name} value={name}>{name.toUpperCase().replaceAll("-", " ")}</option>)}
      </select>
    </div>}
    {!fixtureMode && live.error && live.errorUrl === liveUrl && payload == null ? <ErrorBox message={live.error} retry={live.reload} /> : !fixtureMode && live.loading && !payload ? <Skeleton height={280} /> : <>
      <div className="metric-ribbon">
        <div className={`anchor-metric${waterxReferenceValid ? "" : " reference-unavailable"}`}><span className="metric-label">WATERX PRICE TO BEAT{roundProvisional && <i className="provisional-badge">PROVISIONAL</i>}</span><strong>{waterxReferenceValid ? fmtUsd(round?.referencePrice) : "WaterX reference unavailable"}</strong><small>{waterxReferenceValid ? `${roundProvisional ? "Confirmation pending" : "WaterX reported reference"} · age not reported by source` : `${referenceAvailability?.reason || "No positive reference for the active round"} · last verified age not reported`}</small></div>
        <div className="comparison-metric"><span className="metric-label">CURRENT PRICE <b>· COINBASE</b></span><strong className={comparisonFresh && priceDelta != null ? priceDelta >= 0 ? "gain" : "loss" : comparisonFresh ? "comparison-live" : "dim"}>{comparisonFresh ? fmtUsd(comparison?.price) : "—"}</strong><small>{comparisonFresh ? `Coinbase comparison · ${ago(comparison?.asOf)}` : "No fresh Coinbase comparison quote"}</small></div>
      </div>
      <div className="distance-line">
        <div className="distance-readout"><span>DISTANCE TO REFERENCE</span><strong className={priceDelta == null ? "dim" : priceDelta >= 0 ? "gain" : "loss"}>{priceDelta == null ? "—" : `${priceDelta >= 0 ? "+" : "−"}${fmtUsd(Math.abs(priceDelta))}`}</strong><small>{priceDeltaPct == null ? "Percent unavailable" : `${Math.abs(priceDeltaPct).toFixed(3)}% ${priceDelta! >= 0 ? "above" : "below"}`}</small></div>
        <span className="round-count"><span>BTC · {interval}m CLOSES</span><strong>{roundCurrent && round ? remaining : "—:—"}</strong></span>
      </div>
       <div className="chart-market-layout">
        <section className="chart-panel">
        <div className="section-head chart-head"><div><div className="eyebrow">INDEPENDENT OBSERVATION · COINBASE</div><h2>BTC price trace</h2><p>Coinbase comparison only{waterxReferenceValid ? " · dashed line is the WaterX price to beat" : " · WaterX reference unavailable"}.</p></div><span className={`feed-pill ${streamStatus.toLowerCase()}`}><i />{streamStatus}</span></div>
         {!fixtureMode && chart.error && chart.errorUrl === chartUrl && !chartPayload && !merged.length ? <ErrorBox message={chart.error} retry={chart.reload} /> : !fixtureMode && chart.loading && !chartPayload && !merged.length ? <Skeleton height={330} /> :
             <PriceChart points={merged} interval={interval} anchor={waterxReferenceValid ? round?.referencePrice ?? null : null} streamStatus={streamStatus} round={roundCurrent ? round : null} archiveWindow={chartPayload?.windowMinutes} coveragePartial={chartPayload?.coverage?.partial === true} windowMode={chartWindow} onWindowChange={setChartWindow} referenceDistance={priceDelta} referenceDistancePercent={priceDeltaPct} />}
        {chart.error && chart.errorUrl === chartUrl && <div className="reference-absent">Archive refresh failed. Live Coinbase observations remain visible where available. <button className="text-button" onClick={chart.reload}>Retry archive</button></div>}
        {chartPayload?.coverage?.partial && <div className="gap-caption">Partial archive coverage{chartPayload.coverage.percent != null ? ` · ${chartPayload.coverage.percent}% reported` : ""}{chartPayload.coverage.reason ? ` · ${chartPayload.coverage.reason}` : ""}. Unobserved periods remain blank.</div>}
        {chartPayload && !archiveMatches && <div className="gap-caption">Archive source mismatch: historical points withheld; expected Coinbase comparison data.</div>}
        <div className="legend-row"><span><i className="legend-price" /> Coinbase observations</span><span><i className="legend-anchor" /> WaterX price to beat</span><span className="legend-stamp">Archive: {chartPayload?.source || "not reported"} · stream: Coinbase</span></div>
        <div className="chart-foot"><span>{merged.length.toLocaleString()} retained archive + live records · archive observed span {durationLabel(chartPayload?.coverage?.observationSpanMs)} / {durationLabel(chartPayload?.coverage?.requestedDurationMs ?? (chartPayload?.windowMinutes ?? interval) * 60_000)} · initial unobserved {durationLabel(chartPayload?.coverage?.missingStartMs)}</span><button className="text-button" onClick={chart.reload}><RefreshCw size={13} /> Refresh archive</button></div>
      </section>
        <AdvisoryCards advisory={fixtureMode ? fixtureAdvisory : matchedAdvisory}
          expectedIdentity={expectedAdvisoryIdentity}
          roundCurrent={roundCurrent} quoteCurrent={oddsFresh && (fixtureMode !== null || matchedAdvisory !== null)}
          locked={{ up: upLocked || lockedPair, down: downLocked || lockedPair }}
          nowMs={now} fixtureName={fixtureMode}
          marketOdds={{
            up: upProbabilityCurrent ? fmtProbability(odds?.up) : "Unavailable",
            down: downProbabilityCurrent ? fmtProbability(odds?.down) : "Unavailable",
            current: oddsFresh && roundCurrent,
            source: odds?.source ?? "WaterX",
            asOf: odds?.asOf,
            upPrice: oddsFresh && oddsDisplay.up.priceCents != null ? fmtOdds(oddsDisplay.up.priceCents) : "Withheld",
            downPrice: oddsFresh && oddsDisplay.down.priceCents != null ? fmtOdds(oddsDisplay.down.priceCents) : "Withheld",
          }} />
        </div>
          <details className="round-details"><summary><span>Data health &amp; source details</span><ChevronDown size={14} /></summary><div><span>Round ID</span><b>{roundCurrent ? round?.id : "Unavailable"}</b><span>Window</span><b>{roundCurrent && round ? `${utc(round.startMs)} — ${utc(round.expiryMs)}` : "No active verified window"}</b><span>Reference</span><b>{waterxReferenceValid ? roundProvisional ? "Provisional" : "Reported" : "Unavailable"}</b><span>WaterX odds</span><b>{oddsFresh ? odds?.source : "Not current"} · market observations, not a model forecast</b><span>Market lean</span><b>{waterxLean} · no reliability or economic edge implied</b><span>Model reliability</span><b>Unrated · training {learningTrainCount ?? "not reported"} · forward predictions {forwardCount ?? "not reported"}</b><span>Coinbase chart</span><b>Comparison only; not used for official settlement</b><span>Settlement</span><b>Chainlink BTC/USD TWAP compared with WaterX beginning reference</b><span>Samples</span><b>{merged.length.toLocaleString()} retained archive and live records</b><span>Collection</span><b>{payload?.reason || "No additional collection issue reported"}</b></div></details>
      <details className="method-card"><summary><span><CircleHelp size={15} /> How this market resolves</span><ChevronDown size={15} /></summary><p>The price to beat is the beginning reference reported by WaterX. Settlement uses the official Chainlink BTC/USD time-weighted average price (TWAP), compared with that beginning reference; Up wins at equality. Coinbase is shown only as a live comparison and is never used for settlement.</p></details>
      <div className="live-bottom"><span>{snapshotCurrent ? `Snapshot as of ${utc(payload?.serverTime)}` : payload ? `Last response · stale · ${utc(payload.serverTime)}` : "No current live snapshot"}</span><button className="quiet-button" onClick={refreshAll}><RefreshCw size={14} /> Refresh desk</button><Link href="/health" className="inline-link">Inspect data health <ExternalLink size={13} /></Link></div>
    </>}
  </div>;
}

function PriceChart({ points, interval, anchor, streamStatus, round, archiveWindow, coveragePartial, windowMode, onWindowChange, referenceDistance, referenceDistancePercent }: { points: Point[]; interval: Interval; anchor: number | null; streamStatus: string; round: LivePayload["round"]; archiveWindow?: number; coveragePartial: boolean; windowMode: "observed" | "round" | 5 | 15; onWindowChange: (mode: "observed" | "round" | 5 | 15) => void; referenceDistance: number | null; referenceDistancePercent: number | null }) {
  const measureRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const compact = width < 390;
  const H = 460, left = compact ? 51 : 74, right = compact ? 82 : Math.min(145, Math.max(116, width * .12)), top = 36, bottom = 48;
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
  const partialWindow = coveragePartial || (typeof activeWindowMode === "number" && archiveWindow != null && activeWindowMode > archiveWindow);
  const startInside = !!round && round.startMs >= start && round.startMs <= end;
  const endInside = !!round && round.expiryMs >= start && round.expiryMs <= end;
  const nowInside = nowAt >= start && nowAt <= end;
  const nowX = x(nowAt);
  const nowLabelRightAligned = nowX > plotRight - 116;
  const nowLabelX = nowLabelRightAligned ? Math.max(left + 6, nowX - 5) : Math.min(nowX + 5, plotRight - 4);
  const anchorLabelY = anchor == null ? top : Math.max(top + 12, Math.min(H - bottom - 4, y(anchor) + 18));
   return <div ref={measureRef} className="chart-wrap">
    <div className="chart-controls" role="group" aria-label="Chart time window">
      {(["observed", "round", 5, 15] as const).map(mode => <button key={mode} className={activeWindowMode === mode ? "active" : ""} aria-pressed={activeWindowMode === mode} disabled={mode === "round" && !round} onClick={() => { onWindowChange(mode); setSelectedKey(null); }}>{mode === "observed" ? "Observed" : mode === "round" ? "Full round" : `Last ${mode}m`}</button>)}
       <span>{activeWindowMode === "round" ? "Full round · future unobserved" : activeWindowMode === "observed" ? "Active round · future unobserved" : "Rolling archive"}{partialWindow ? " · partial" : ""}</span>
      {active && <button className="return-live" onClick={() => setSelectedKey(null)}>Return to live</button>}
    </div>
     {anchor != null && <div className={`chart-distance-readout ${referenceDistance == null ? "unavailable" : referenceDistance >= 0 ? "above" : "below"}`}>
       <span>Coinbase vs WaterX reference</span>
       <b>{referenceDistance == null ? "Distance unavailable" : `${referenceDistance >= 0 ? "+" : "−"}${fmtUsd(Math.abs(referenceDistance))}`}</b>
       <small>{referenceDistancePercent == null ? "Percent unavailable" : `${Math.abs(referenceDistancePercent).toFixed(3)}% ${referenceDistance! >= 0 ? "above" : "below"}`}</small>
     </div>}
    {samples.length ? <div className="chart-measure">
       <svg ref={svgRef} className={`price-chart ${tone}`} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`Coinbase BTC comparison observations over ${activeWindowMode === "round" || activeWindowMode === "observed" ? "the active round through close" : `${activeWindowMode} minutes`}; gaps are not interpolated${anchor == null ? "" : "; dashed line is the current WaterX reported reference"}`}>
        <defs><linearGradient id="price-underlay" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" className="area-start" stopOpacity=".22" /><stop offset="100%" className="area-start" stopOpacity="0" /></linearGradient></defs>
         {anchor != null && <><rect x={left} y={top} width={plotRight - left} height={Math.max(0, y(anchor) - top)} className="reference-zone-above" /><rect x={left} y={y(anchor)} width={plotRight - left} height={Math.max(0, H - bottom - y(anchor))} className="reference-zone-below" /></>}
         {[0, .5, 1].map((f, i) => { const py = top + f * (H - top - bottom); const price = hi - f * (hi - lo); const axisPrice = width < 500 ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(price) : fmtUsd(price); return <g key={i}><line x1={left} x2={plotRight} y1={py} y2={py} className="gridline" /><text x={left - 7} y={py + 4} textAnchor="end" className="axis-label">{axisPrice}</text></g>; })}
         {(compact ? [0, .5, 1] : [0, 1 / 3, 2 / 3, 1]).map((f, i) => {
           const at = start + f * (end - start), px = x(at);
           const timeText = new Date(at).toLocaleTimeString([], compact
             ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
             : { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
           return <g key={`time-${i}`}><line x1={px} x2={px} y1={top} y2={H - bottom} className="time-tick" /><text x={px} y={H - 10} textAnchor={i === 0 ? "start" : i === (compact ? 2 : 3) ? "end" : "middle"} className="time-label">{timeText}{compact ? "" : " UTC"}</text></g>;
         })}
         {nowInside && <><rect x={nowX} y={top} width={Math.max(0, plotRight - nowX)} height={H - top - bottom} className="future-shade" /><line x1={nowX} x2={nowX} y1={top} y2={H - bottom} className="now-line" /><text x={nowLabelX} y={top + 13} textAnchor={nowLabelRightAligned ? "end" : "start"} className="now-label">NOW · NO PROJECTION</text></>}
         {anchor != null && <><line x1={left} x2={plotRight} y1={y(anchor)} y2={y(anchor)} className="anchor-line" /><text x={left + 6} y={anchorLabelY} textAnchor="start" className="anchor-label">{`WATERX PRICE TO BEAT ${fmtUsd(anchor)}`}</text></>}
        {chunks.map((segment, idx) => <g key={idx}>
          {segment.length > 1 && <polygon points={`${x(Number(segment[0].at))},${H - bottom} ${segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} ${x(Number(segment.at(-1)!.at))},${H - bottom}`} className="price-area" />}
          {segment.length > 1 && <polyline points={segment.map(p => `${x(Number(p.at))},${y(p.price!)}`).join(" ")} className="price-line" />}
        </g>)}
         {latest?.price != null && <g><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="8" className="latest-halo" /><circle cx={x(Number(latest.at))} cy={y(latest.price)} r="4" className="latest-dot" /><text x={plotRight + 7} y={Math.max(top + 9, Math.min(H - bottom - 5, y(latest.price) + 4))} className="latest-label">{fmtUsd(latest.price)}</text></g>}
        {active?.price != null && <g><line x1={x(Number(active.at))} x2={x(Number(active.at))} y1={top} y2={H - bottom} className="inspect-line" /><circle cx={x(Number(active.at))} cy={y(active.price)} r="5" className="inspect-point" /></g>}
        {startInside && <><line x1={x(round!.startMs)} x2={x(round!.startMs)} y1={top} y2={H - bottom} className="round-boundary" /><text x={x(round!.startMs) + 4} y={H - 8} className="boundary-label">START</text></>}
        {endInside && <><line x1={x(round!.expiryMs)} x2={x(round!.expiryMs)} y1={top} y2={H - bottom} className="round-boundary" /><text x={x(round!.expiryMs) - 4} y={H - 8} textAnchor="end" className="boundary-label">CLOSE</text></>}
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
    {result.error && result.errorUrl === url ? <ErrorBox message={result.error} retry={result.reload} /> : !intervalResponseReady ? <Skeleton height={360} /> : <>
      <section className={`learning-status ${ready ? "ready" : "not-ready"}`}>
        <div><span className="eyebrow">{interval}-MINUTE MARKET COHORT</span><strong>{ready ? "Readiness gates met" : status === "insufficient" ? "More verified history needed" : status.replace(/[_-]/g, " ")}</strong>
          <p>{ready ? "Eligibility gates are met for this interval. Metrics below appear only when the service has actually scored them." : `Readiness is interval-specific. This ${interval}-minute cohort is not currently eligible for a promoted forecast.`}</p>
        </div><span className={`readiness-badge ${ready ? "pass" : ""}`}>{ready ? "READY" : "BUILDING EVIDENCE"}</span>
      </section>

      <section className="readiness-panel">
        <div className="learning-section-heading"><div><div className="eyebrow">PERSISTED LEARNING STATE</div><h2>Latest evidence and training</h2></div><span>{interval}m only</span></div>
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
          <div><span>Published source archive</span><b><a href="https://github.com/lifeguarddotsui-GPT/signal-desk-btc/tree/waterx-deployed-f106fff" target="_blank" rel="noreferrer">Audited deployed snapshot</a> · repository main is older</b></div>
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
    <Route path="/history" component={HistoryPage} />
    <Route path="/learn" component={LearningPage} />
    <Route path="/health" component={HealthPage} />
    <Route><div className="page not-found"><div className="eyebrow">NO SUCH VIEW</div><h1>This page isn't on the desk.</h1><Link href="/" className="inline-link">Back to live desk</Link></div></Route>
  </Switch></Shell>;
}