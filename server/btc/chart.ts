import { comparisonBtc } from "./source";

export const MIN_CAPTURE_INTERVAL_MS = 3_000;
export const CHART_WINDOW_MS = 5 * 60_000;
export const SERIES_RETENTION_MS = 10 * 60_000;
export const SERIES_MAX_POINTS = 512;
export const GAP_AFTER_MS = 15_000;
export const COMPARISON_SOURCE = "Coinbase comparison only (not settlement oracle)";
const MAX_SOURCE_AGE_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export type ComparisonTick = { price: number; asOf: string; source?: string };
export type ArchivedChartPoint = { at: number; price: number; sourceAt?: string | null };
export type ChartSample = {
  at: number;
  price: number;
  source: typeof COMPARISON_SOURCE;
  sourceAt: string | null;
  sourceAgeMs: number | null;
  receivedAt: string;
  serverEventAt: string;
  sourceToServerLatencyMs: number | null;
};
export type ChartGap = { at: number; price: null; gap: true; reason?: string };
export type ChartEntry = ChartSample | ChartGap;

type CapturedPoint = { at: number; price: number; sourceAt: string; sourceToServerLatencyMs: number | null };
type CaptureOptions = {
  read?: () => Promise<ComparisonTick>;
  intervalMs?: number;
  now?: () => number;
  maxPoints?: number;
  onTick?: (point: CapturedPoint) => void;
  onFailure?: (at: number, reason: string) => void;
};

/**
 * Creates an independent comparison-price sampler. Scheduling waits until a
 * read completes, so slow provider calls can never overlap. `accept` is exposed
 * for deterministic tests and controlled ingestion; it rejects stale,
 * future-dated, invalid, and duplicate provider ticks.
 */
export function createPriceCapture(options: CaptureOptions = {}) {
  const read = options.read ?? comparisonBtc;
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(MIN_CAPTURE_INTERVAL_MS, options.intervalMs ?? 5_000);
  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? SERIES_MAX_POINTS));
  const points: CapturedPoint[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let busy = false;
  let failures = 0;
  let lastSourceAt = -Infinity;

  function accept(tick: ComparisonTick): boolean {
    const receivedAt = now();
    const sourceTime = Date.parse(tick.asOf);
    const age = receivedAt - sourceTime;
    if (!Number.isFinite(tick.price) || tick.price <= 0 ||
        !Number.isFinite(sourceTime) || age > MAX_SOURCE_AGE_MS || age < -2_000 ||
        sourceTime <= lastSourceAt) return false;

    lastSourceAt = sourceTime;
    const point = {
      at: receivedAt, price: tick.price, sourceAt: new Date(sourceTime).toISOString(),
      sourceToServerLatencyMs: age >= 0 ? age : null,
    };
    points.push(point);
    options.onTick?.(point);
    const cutoff = receivedAt - SERIES_RETENTION_MS;
    while (points.length && points[0].at < cutoff) points.shift();
    while (points.length > maxPoints) points.shift();
    return true;
  }

  function delayAfterFailure(): number {
    failures = Math.min(failures + 1, 16);
    return Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures - 1, 8));
  }

  async function runOnce(): Promise<void> {
    if (busy) return;
    busy = true;
    let delay = intervalMs;
    try {
      const tick = await read();
      if (!accept(tick)) throw new Error("Coinbase comparison tick rejected as stale, invalid, or duplicate");
      failures = 0;
    } catch (error) {
      delay = delayAfterFailure();
      options.onFailure?.(now(), error instanceof Error ? error.message : "Comparison feed read failed");
      console.warn("[btc-chart] Coinbase comparison capture failed", error);
    } finally {
      busy = false;
      if (running) {
        timer = setTimeout(() => void runOnce(), delay);
        timer.unref?.();
      }
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    void runOnce();
  }

  function stop(): void {
    running = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function getPoints(): ChartSample[] {
    const currentTime = now();
    return points.map(point => ({
      at: point.at,
      price: point.price,
      source: COMPARISON_SOURCE,
      sourceAt: point.sourceAt,
      sourceAgeMs: Math.max(0, currentTime - Date.parse(point.sourceAt)),
      receivedAt: new Date(point.at).toISOString(),
      serverEventAt: new Date(point.at).toISOString(),
      sourceToServerLatencyMs: point.sourceToServerLatencyMs,
    }));
  }

  return { start, stop, accept, getPoints };
}

export type ChartStreamEvent = {
  id: number;
  type: "tick" | "gap";
  at: number;
  data: ChartSample | ChartGap;
};
const STREAM_MAX_EVENTS = 512;
const streamEvents: ChartStreamEvent[] = [];
const streamListeners = new Set<(event: ChartStreamEvent) => void>();
let streamEventId = 0;
let streamGapOpen = false;
let streamLastTickAt: number | null = null;
const streamStartedAt = Date.now();

function publishStreamEvent(type: ChartStreamEvent["type"], at: number, data: ChartSample | ChartGap) {
  const event = { id: ++streamEventId, type, at, data };
  streamEvents.push(event);
  while (streamEvents.length > STREAM_MAX_EVENTS) streamEvents.shift();
  for (const listener of Array.from(streamListeners)) {
    try { listener(event); } catch { /* One disconnected SSE client cannot stop chart ingestion. */ }
  }
}

function publishTick(point: CapturedPoint) {
  const serverEventAt = new Date(point.at).toISOString();
  const sample: ChartSample = {
    at: point.at, price: point.price, source: COMPARISON_SOURCE,
    sourceAt: point.sourceAt, sourceAgeMs: point.sourceToServerLatencyMs,
    receivedAt: serverEventAt, serverEventAt,
    sourceToServerLatencyMs: point.sourceToServerLatencyMs,
  };
  streamLastTickAt = point.at;
  streamGapOpen = false;
  publishStreamEvent("tick", point.at, sample);
}

function publishGap(at: number, reason: string) {
  if (streamGapOpen) return;
  streamGapOpen = true;
  publishStreamEvent("gap", at, {
    at, price: null, gap: true, reason: reason.slice(0, 180),
  });
}

/** Publish genuine stale-feed gaps without interpolating or inventing prices. */
export function checkChartFreshness(now = Date.now()): void {
  const referenceAt = streamLastTickAt ?? streamStartedAt;
  if (now - referenceAt > GAP_AFTER_MS)
    publishGap(Math.min(now, referenceAt + GAP_AFTER_MS + 1),
      streamLastTickAt === null ? "No comparison tick received; feed unavailable" : "Comparison feed stale or disconnected");
}

export function subscribeChartEvents(listener: (event: ChartStreamEvent) => void): () => void {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
}

export function chartEventsAfter(id: number): ChartStreamEvent[] {
  return streamEvents.filter(event => event.id > id);
}

export function latestChartEventId(): number {
  return streamEventId;
}

export function chartReplayPlan(
  cursor: number,
  latestId: number,
  earliestRetainedId: number | undefined,
): { reset: "restart" | "buffer-exhausted" | null; cursor: number } {
  if (cursor > latestId) {
    // Reset the browser's Last-Event-ID to just before the retained replay
    // range. If this is a fresh process with no events, latestId is zero.
    return { reset: "restart", cursor: Math.max(0, (earliestRetainedId ?? latestId) - 1) };
  }
  if (cursor > 0 && earliestRetainedId !== undefined && cursor < earliestRetainedId - 1)
    return { reset: "buffer-exhausted", cursor: latestId };
  return { reset: null, cursor };
}

const priceCapture = createPriceCapture({
  onTick: publishTick,
  onFailure: (at, reason) => publishGap(at, `Comparison feed disconnected: ${reason}`),
});

/** Start the independent Coinbase comparison chart poller (minimum 3s cadence). */
export function startPriceCapture(): () => void {
  priceCapture.start();
  return () => priceCapture.stop();
}

/** A fresh provider-stamped tick, independent of round discovery. */
export function latestComparison() {
  const tick = priceCapture.getPoints().at(-1);
  return tick && tick.sourceAt && tick.sourceAgeMs !== null &&
    tick.sourceAgeMs <= 20_000
    ? { price: tick.price, asOf: tick.sourceAt, source: COMPARISON_SOURCE }
    : null;
}

/**
 * Combine existing archived observations with recent in-memory observations.
 * Null-price entries are explicit line breaks; no prices are synthesized
 * within a gap. Historical archive entries have unknown source age.
 */
export function chartSeries(
  archived: readonly ArchivedChartPoint[] = [],
  now = Date.now(),
  windowMs = CHART_WINDOW_MS,
): ChartEntry[] {
  return buildChartSeries(archived, priceCapture.getPoints(), now, windowMs);
}

export function buildChartSeries(
  archived: readonly ArchivedChartPoint[],
  captured: readonly ChartSample[],
  now: number,
  windowMs = CHART_WINDOW_MS,
): ChartEntry[] {
  const cutoff = now - windowMs;
  const merged = new Map<number, ChartSample>();

  for (const point of archived) {
    if (Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0 &&
        point.at >= cutoff && point.at <= now) {
      const sourceMs = point.sourceAt ? Date.parse(point.sourceAt) : NaN;
      const sourceValid = Number.isFinite(sourceMs) && sourceMs <= point.at &&
        point.at - sourceMs <= MAX_SOURCE_AGE_MS;
      merged.set(point.at, {
        at: point.at, price: point.price, source: COMPARISON_SOURCE,
        sourceAt: sourceValid ? new Date(sourceMs).toISOString() : null,
        sourceAgeMs: sourceValid ? Math.max(0, now - sourceMs) : null,
        receivedAt: new Date(point.at).toISOString(),
        serverEventAt: new Date(point.at).toISOString(),
        sourceToServerLatencyMs: sourceValid ? point.at - sourceMs : null,
      });
    }
  }
  for (const point of captured) {
    if (point.at >= cutoff && point.at <= now) merged.set(point.at, point);
  }

  const samples = Array.from(merged.values()).sort((a, b) => a.at - b.at);
  const result: ChartEntry[] = [];
  for (let i = 0; i < samples.length; i++) {
    const point = samples[i];
    if (i > 0 && point.at - samples[i - 1].at > GAP_AFTER_MS) {
      result.push({ at: Math.floor((samples[i - 1].at + point.at) / 2), price: null, gap: true });
    }
    result.push(point);
  }
  // A stopped feed must not look like a continuing line merely because the
  // last valid point remains inside the five-minute history window.
  if (samples.length && now - samples[samples.length - 1].at > GAP_AFTER_MS)
    result.push({ at: Math.min(now, samples[samples.length - 1].at + GAP_AFTER_MS + 1),
      price: null, gap: true });
  return result;
}