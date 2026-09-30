import { comparisonBtc } from "./source";
import { createCoinbaseStream } from "./coinbase-stream";
import { persistComparisonTick } from "./chart-history";
import { recordComparisonPublication } from "../waterx/latency";

export const MIN_CAPTURE_INTERVAL_MS = 3_000;
export const CHART_WINDOW_MS = 5 * 60_000;
export const SERIES_RETENTION_MS = 15 * 60_000;
export const SERIES_MAX_POINTS = 25_000;
export const GAP_AFTER_MS = 15_000;
export const COMPARISON_SOURCE = "Coinbase comparison only (not settlement oracle)";
const MAX_SOURCE_AGE_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export type ComparisonTick = { price: number; asOf: string; source?: string; eventId?: string };
export type ArchivedChartPoint = {
  at: number; price: number; sourceAt?: string | null; observedAt?: string | null;
  archiveId?: string; eventId?: string;
};
export type ChartSample = {
  at: number;
  price: number;
  source: string;
  sourceAt: string | null;
  sourceAgeMs: number | null;
  archiveId?: string;
  eventId?: string;
  receivedAt: string;
  serverEventAt: string;
  sourceToServerLatencyMs: number | null;
};
export type ChartGap = { at: number; price: null; gap: true; reason?: string };
export type ChartEntry = ChartSample | ChartGap;

type CapturedPoint = {
  at: number; price: number; sourceAt: string; sourceToServerLatencyMs: number | null;
  source?: string; eventId?: string;
};
type CaptureOptions = {
  read?: () => Promise<ComparisonTick>;
  intervalMs?: number;
  now?: () => number;
  maxPoints?: number;
  onTick?: (point: CapturedPoint) => void;
  onFailure?: (at: number, reason: string) => void;
};

/** Reduce dense capture without inventing samples: retain each time bucket's
 * source-time edges and extrema, then keep the full retention window. */
export function boundCapturedPoints(
  input: readonly CapturedPoint[],
  maxPoints: number,
  retentionMs = SERIES_RETENTION_MS,
): CapturedPoint[] {
  if (input.length <= maxPoints) return [...input];
  if (maxPoints < 4) return input.slice(-maxPoints);
  const endAt = input.at(-1)!.at;
  const startAt = endAt - retentionMs;
  const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
  const bucketWidth = Math.max(1, retentionMs / bucketCount);
  const buckets = new Map<number, CapturedPoint[]>();
  for (const point of input) {
    const bucket = Math.min(bucketCount - 1,
      Math.max(0, Math.floor((point.at - startAt) / bucketWidth)));
    const group = buckets.get(bucket) ?? [];
    group.push(point);
    buckets.set(bucket, group);
  }
  const selected = new Map<string, CapturedPoint>();
  buckets.forEach(group => {
    const candidates = [
      group[0],
      group.at(-1)!,
      group.reduce((min: CapturedPoint, point: CapturedPoint) =>
        point.price < min.price ? point : min),
      group.reduce((max: CapturedPoint, point: CapturedPoint) =>
        point.price > max.price ? point : max),
    ];
    for (const point of candidates)
      selected.set(point.eventId ?? `${point.sourceAt}:${point.price}`, point);
  });
  return Array.from(selected.values()).sort((a, b) => a.at - b.at).slice(-maxPoints);
}

/**
 * Bounded in-memory comparison capture. `accept` is exposed for deterministic
 * tests and controlled ingestion; it rejects stale, future-dated, invalid,
 * out-of-order, and duplicate provider events.
 */
export function createPriceCapture(options: CaptureOptions = {}) {
  const read: () => Promise<ComparisonTick> = options.read ?? comparisonBtc;
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(MIN_CAPTURE_INTERVAL_MS, options.intervalMs ?? 5_000);
  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? SERIES_MAX_POINTS));
  const points: CapturedPoint[] = [];
  const eventIds = new Set<string>();
  const eventIdQueue: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let busy = false;
  let failures = 0;
  let lastSourceAt = -Infinity;

  function accept(tick: ComparisonTick): boolean {
    if (tick.eventId && eventIds.has(tick.eventId)) return false;
    const receivedAt = now();
    const sourceTime = Date.parse(tick.asOf);
    const age = receivedAt - sourceTime;
    if (!Number.isFinite(tick.price) || tick.price <= 0 ||
        !Number.isFinite(sourceTime) || age > MAX_SOURCE_AGE_MS || age < -2_000 ||
        sourceTime < lastSourceAt || (sourceTime === lastSourceAt && !tick.eventId)) return false;

    lastSourceAt = Math.max(lastSourceAt, sourceTime);
    if (tick.eventId) {
      eventIds.add(tick.eventId);
      eventIdQueue.push(tick.eventId);
      while (eventIdQueue.length > 2_048) eventIds.delete(eventIdQueue.shift()!);
    }
    const point = {
      at: receivedAt, price: tick.price, sourceAt: new Date(sourceTime).toISOString(),
      sourceToServerLatencyMs: age >= 0 ? age : null,
      source: tick.source,
      eventId: tick.eventId,
    };
    points.push(point);
    options.onTick?.(point);
    const cutoff = receivedAt - SERIES_RETENTION_MS;
    while (points.length && points[0].at < cutoff) points.shift();
    const compactionThreshold = maxPoints < 4 ? maxPoints : Math.ceil(maxPoints * 1.25);
    if (points.length > compactionThreshold) {
      const bounded = boundCapturedPoints(points, maxPoints);
      points.splice(0, points.length, ...bounded);
    }
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
      if (!accept(tick)) {
        if (tick.eventId && eventIds.has(tick.eventId)) {
          failures = 0;
          return;
        }
        throw new Error("Coinbase comparison tick rejected as stale, invalid, or duplicate");
      }
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
      source: point.source ?? COMPARISON_SOURCE,
      sourceAt: point.sourceAt,
      sourceAgeMs: Math.max(0, currentTime - Date.parse(point.sourceAt)),
      ...(point.eventId ? { eventId: point.eventId } : {}),
      receivedAt: new Date(point.at).toISOString(),
      serverEventAt: new Date(point.at).toISOString(),
      sourceToServerLatencyMs: point.sourceToServerLatencyMs,
    }));
  }

  return { start, stop, accept, hasEvent: (eventId: string) => eventIds.has(eventId), getPoints };
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
  const publishedAt = Date.now();
  const serverEventAt = new Date(publishedAt).toISOString();
  const sample: ChartSample = {
    at: point.at, price: point.price, source: point.source ?? COMPARISON_SOURCE,
    sourceAt: point.sourceAt, sourceAgeMs: point.sourceToServerLatencyMs,
    receivedAt: new Date(point.at).toISOString(), serverEventAt,
    sourceToServerLatencyMs: point.sourceToServerLatencyMs,
    ...(point.eventId ? { eventId: point.eventId } : {}),
  };
  streamLastTickAt = point.at;
  streamGapOpen = false;
  publishStreamEvent("tick", point.at, sample);
  recordComparisonPublication(point.at, publishedAt);
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
  onTick: point => {
    publishTick(point);
    persistComparisonTick({
      price: point.price,
      sourceAt: point.sourceAt,
      receivedAt: new Date(point.at).toISOString(),
      source: point.source ?? COMPARISON_SOURCE,
      ...(point.eventId ? { eventId: point.eventId } : {}),
      sourceToServerLatencyMs: point.sourceToServerLatencyMs,
    });
  },
});
const coinbaseStream = createCoinbaseStream({
  readFallback: comparisonBtc,
  onTick: tick => {
    if (!priceCapture.accept(tick) && !priceCapture.hasEvent(tick.eventId))
      publishGap(Date.now(), "Coinbase exchange event rejected as stale, invalid, or out of order");
  },
  onGap: (at, reason) => publishGap(at, reason),
});

/** Controlled comparison ingestion shared by the feed and deterministic stream tests. */
export function acceptComparisonTick(tick: ComparisonTick): boolean {
  return priceCapture.accept(tick);
}

/** Start the shared Coinbase Exchange comparison WebSocket feed. */
export function startPriceCapture(): () => void {
  coinbaseStream.start();
  return () => {
    coinbaseStream.stop();
    priceCapture.stop();
  };
}

/** A fresh provider-stamped tick, independent of round discovery. */
export function latestComparison() {
  const tick = priceCapture.getPoints().at(-1);
  return tick && tick.sourceAt && tick.sourceAgeMs !== null &&
    tick.sourceAgeMs <= 20_000
    ? { price: tick.price, asOf: tick.sourceAt, source: tick.source }
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
  const merged = new Map<string, ChartSample>();
  const capturedEventIds = new Set(captured
    .filter(point => point.at >= cutoff && point.at <= now && point.eventId)
    .map(point => point.eventId!));
  const capturedAnonymousSamples = new Set(captured
    .filter(point => point.at >= cutoff && point.at <= now && !point.eventId)
    .map(point => `${point.sourceAt ?? point.at}|${point.price}`));
  const archivedEventIds = new Set<string>();
  const archivedAnonymousSamples = new Set<string>();

  for (const point of archived) {
    if (Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0 &&
        point.at >= cutoff && point.at <= now) {
      const anonymousKey = `${point.sourceAt ?? point.at}|${point.price}`;
      if (point.eventId) {
        if (capturedEventIds.has(point.eventId) || archivedEventIds.has(point.eventId)) continue;
        archivedEventIds.add(point.eventId);
      } else {
        if (capturedAnonymousSamples.has(anonymousKey) || archivedAnonymousSamples.has(anonymousKey)) continue;
        archivedAnonymousSamples.add(anonymousKey);
      }
      const sourceMs = point.sourceAt ? Date.parse(point.sourceAt) : NaN;
      const receivedMs = point.observedAt ? Date.parse(point.observedAt) : point.at;
      const sourceValid = Number.isFinite(sourceMs) && sourceMs <= point.at &&
        point.at - sourceMs <= MAX_SOURCE_AGE_MS;
      merged.set(point.archiveId ?? `${point.at}:${point.price}`, {
        at: point.at, price: point.price, source: COMPARISON_SOURCE,
        sourceAt: sourceValid ? new Date(sourceMs).toISOString() : null,
        sourceAgeMs: sourceValid ? Math.max(0, now - sourceMs) : null,
        receivedAt: new Date(receivedMs).toISOString(),
        serverEventAt: new Date(receivedMs).toISOString(),
        sourceToServerLatencyMs: sourceValid && receivedMs >= sourceMs ? receivedMs - sourceMs : null,
        ...(point.archiveId ? { archiveId: point.archiveId } : {}),
        ...(point.eventId ? { eventId: point.eventId } : {}),
      });
    }
  }
  const samples = [
    ...Array.from(merged.values()),
    ...captured.filter(point => point.at >= cutoff && point.at <= now),
  ].sort((a, b) => a.at - b.at);
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