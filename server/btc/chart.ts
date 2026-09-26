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
};
export type ChartGap = { at: number; price: null; gap: true };
export type ChartEntry = ChartSample | ChartGap;

type CapturedPoint = { at: number; price: number; sourceAt: string };
type CaptureOptions = {
  read?: () => Promise<ComparisonTick>;
  intervalMs?: number;
  now?: () => number;
  maxPoints?: number;
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
    points.push({ at: receivedAt, price: tick.price, sourceAt: new Date(sourceTime).toISOString() });
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
    }));
  }

  return { start, stop, accept, getPoints };
}

const priceCapture = createPriceCapture();

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
): ChartEntry[] {
  return buildChartSeries(archived, priceCapture.getPoints(), now);
}

export function buildChartSeries(
  archived: readonly ArchivedChartPoint[],
  captured: readonly ChartSample[],
  now: number,
): ChartEntry[] {
  const cutoff = now - CHART_WINDOW_MS;
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