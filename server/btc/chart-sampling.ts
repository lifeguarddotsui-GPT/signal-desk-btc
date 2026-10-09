/**
 * Archive at most one authentic exchange event per cadence window. The live
 * WebSocket, on-screen chart and model feature stream remain unsampled.
 * Call markQueued only after the durable writer accepts the record; queue
 * backpressure must not silently mark a failed write as archived.
 */
export const DEFAULT_COMPARISON_ARCHIVE_SAMPLE_MS = 5_000;

export function createComparisonArchiveSampler(cadenceMs = DEFAULT_COMPARISON_ARCHIVE_SAMPLE_MS) {
  if (!Number.isFinite(cadenceMs) || cadenceMs < 0)
    throw new RangeError("Archive sample period must be finite and nonnegative.");
  let lastQueuedAt = -Infinity;
  return {
    shouldQueue(atMs: number): boolean {
      return Number.isFinite(atMs) &&
        atMs >= lastQueuedAt &&
        (cadenceMs === 0 || atMs - lastQueuedAt >= cadenceMs);
    },
    markQueued(atMs: number): void {
      if (!Number.isFinite(atMs) || atMs < lastQueuedAt)
        throw new RangeError("Archive timestamp must be monotonic.");
      lastQueuedAt = atMs;
    },
  };
}

/** false disables sampling to restore the old per-event archival behavior. */
export function archiveSamplePeriodMs(environmentValue: string | undefined): number {
  return environmentValue === "false" ? 0 : DEFAULT_COMPARISON_ARCHIVE_SAMPLE_MS;
}
