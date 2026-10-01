/** Same-clock receive-to-render timing for this browser tab; never server/network latency. */
const samples: { at: number; latencyMs: number }[] = [];
const MAX_SAMPLES = 1200;
const WINDOW_MS = 60 * 60_000;

export function recordBrowserRender(receivedAtPerformanceMs: number, renderedAtPerformanceMs: number, at = Date.now()): void {
  const latencyMs = renderedAtPerformanceMs - receivedAtPerformanceMs;
  if (!Number.isFinite(at) || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60_000) return;
  samples.push({ at, latencyMs });
  while (samples.length > MAX_SAMPLES || samples[0]?.at < at - WINDOW_MS) samples.shift();
}

export function browserRenderSummary(now = Date.now()) {
  const relevant = samples.filter(sample => sample.at >= now - WINDOW_MS);
  const sorted = relevant.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position);
    return Math.round((sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low)) * 100) / 100;
  };
  return {
    status: relevant.length ? "measured" as const : "unavailable" as const,
    sampleCount: relevant.length,
    observedFrom: relevant[0] ? new Date(relevant[0].at).toISOString() : null,
    observedUntil: relevant.at(-1) ? new Date(relevant.at(-1)!.at).toISOString() : null,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
    note: "Local browser event receipt to first post-React animation frame; tab-local and resets on reload. Not network latency.",
  };
}