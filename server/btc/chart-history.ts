import pg from "pg";
import type { ArchivedChartPoint } from "./chart";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

// A 15-minute archive normally contains only a few hundred prospective
// snapshots. Keep a generous hard query bound and a separate response bound
// for unexpectedly dense/long-lived databases.
export const COMPARISON_ARCHIVE_MAX_ROWS = 25_000;
export const COMPARISON_ARCHIVE_MAX_POINTS = 4_000;
const MAX_CAPTURE_AGE_MS = 20_000;

type ArchiveDbRow = {
  id: string;
  observed_at?: Date | string;
  comparison_at?: Date | string;
  comparison_price?: string;
  source_at?: Date | string;
  received_at?: Date | string;
  price?: string;
  source?: string;
  event_id?: string | null;
};
type ArchiveQuery = (sql: string, values: unknown[]) => Promise<{ rows: ArchiveDbRow[] }>;
export type PersistableComparisonTick = {
  price: number;
  sourceAt: string;
  receivedAt: string;
  source: string;
  eventId?: string;
  sourceToServerLatencyMs: number | null;
};
export type ComparisonTickPersistenceHealth = {
  status: "unknown" | "healthy" | "degraded";
  queueDepth: number;
  droppedTicks: number;
  lastSuccessAt: string | null;
  lastFailure: string | null;
};

type TickWrite = (tick: PersistableComparisonTick) => Promise<void>;

/** Bounded, sequential, non-blocking archive writer. Failed writes stay queued
 * for retry; overflow is counted and surfaced instead of silently hidden. */
export function createComparisonTickWriter(
  write: TickWrite,
  maxQueue = 512,
  now: () => number = Date.now,
) {
  const queue: PersistableComparisonTick[] = [];
  const pendingKeys = new Set<string>();
  let status: ComparisonTickPersistenceHealth["status"] = "unknown";
  let droppedTicks = 0;
  let lastSuccessAt: string | null = null;
  let lastFailure: string | null = null;
  let activeDrain: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const keyOf = (tick: PersistableComparisonTick) =>
    tick.eventId ? `event:${tick.eventId}` :
      `${tick.sourceAt}|${tick.price}|${tick.source}`;

  function scheduleRetry() {
    if (retryTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, delay);
    retryTimer.unref?.();
  }

  function drain(): Promise<void> {
    if (activeDrain) return activeDrain;
    activeDrain = (async () => {
      try {
        while (queue.length) {
          const tick = queue[0];
          try {
            await write(tick);
            queue.shift();
            pendingKeys.delete(keyOf(tick));
            failures = 0;
            status = droppedTicks ? "degraded" : "healthy";
            lastSuccessAt = new Date(now()).toISOString();
            if (!droppedTicks) lastFailure = null;
          } catch (error) {
            failures++;
            status = "degraded";
            lastFailure = error instanceof Error ? error.message.slice(0, 180) : "Database write failed";
            scheduleRetry();
            break;
          }
        }
      } finally {
        activeDrain = null;
      }
    })();
    return activeDrain;
  }

  function enqueue(tick: PersistableComparisonTick): boolean {
    const key = keyOf(tick);
    if (pendingKeys.has(key)) return false;
    if (queue.length >= Math.max(1, maxQueue)) {
      droppedTicks++;
      status = "degraded";
      lastFailure = `Archive queue full; dropped tick (${droppedTicks} total)`;
      return false;
    }
    queue.push(tick);
    pendingKeys.add(key);
    void drain();
    return true;
  }

  function health(): ComparisonTickPersistenceHealth {
    return { status, queueDepth: queue.length, droppedTicks, lastSuccessAt, lastFailure };
  }
  return { enqueue, health, drain };
}

const defaultTickWriter = createComparisonTickWriter(async tick => {
  await pool.query(
    `INSERT INTO waterx_comparison_ticks
      (source_at, received_at, price, source, event_id, source_to_server_latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [tick.sourceAt, tick.receivedAt, tick.price, tick.source, tick.eventId ?? null,
      tick.sourceToServerLatencyMs],
  );
});

export function persistComparisonTick(tick: PersistableComparisonTick): boolean {
  return defaultTickWriter.enqueue(tick);
}

export function comparisonTickPersistenceHealth(): ComparisonTickPersistenceHealth {
  return defaultTickWriter.health();
}

export type ComparisonArchiveCoverage = {
  status: "available" | "partial" | "unavailable";
  requestedStartAt: string;
  requestedEndAt: string;
  oldestSourceAt: string | null;
  newestSourceAt: string | null;
  returnedPoints: number;
  truncated: boolean;
  archiveSource?: "coinbase_ticks" | "coinbase_ticks+legacy_snapshots" | "legacy_snapshots";
  persistence: ComparisonTickPersistenceHealth;
  reason?: string;
};
export type ComparisonSeriesCoverage = ComparisonArchiveCoverage & {
  observationSpanMs: number;
  requestedDurationMs: number;
  missingStartMs: number | null;
  missingEndMs: number | null;
  gapCount: number;
  observedPointCount: number;
  measurement: string;
};
export type PersistedComparisonArchive = {
  points: ArchivedChartPoint[];
  coverage: ComparisonArchiveCoverage;
};

/** Describe elapsed span and explicit gaps across the archive-plus-stream
 * response. A point span is not a claim of continuous observation. */
export function comparisonSeriesCoverage(
  points: readonly { at: number; price: number | null; sourceAt?: string | null; gap?: boolean }[],
  archive: ComparisonArchiveCoverage,
  requestedStartMs: number,
  requestedEndMs: number,
  gapAfterMs = 15_000,
): ComparisonSeriesCoverage {
  const observations = points.flatMap(point => {
    if (point.price === null || !Number.isFinite(point.price) || point.price <= 0 ||
        !Number.isFinite(point.at)) return [];
    const sourceAt = point.sourceAt ? Date.parse(point.sourceAt) : point.at;
    return [{ at: Number.isFinite(sourceAt) ? sourceAt : point.at }];
  }).sort((a, b) => a.at - b.at);
  const first = observations[0]?.at;
  const last = observations.at(-1)?.at;
  const requestedDurationMs = Math.max(0, requestedEndMs - requestedStartMs);
  const observationSpanMs = first === undefined || last === undefined ? 0 : last - first;
  const missingStartMs = first === undefined ? null : Math.max(0, first - requestedStartMs);
  const missingEndMs = last === undefined ? null : Math.max(0, requestedEndMs - last);
  const gapCount = points.filter(point => point.gap === true || point.price === null).length;
  const missingEdge = first === undefined || last === undefined ||
    first - requestedStartMs > gapAfterMs || requestedEndMs - last > gapAfterMs;
  const status = archive.status === "available" && !missingEdge && gapCount === 0
    ? "available" : archive.status === "unavailable" && observations.length === 0
      ? "unavailable" : "partial";
  const reason = archive.reason ??
    (observations.length === 0
      ? "No source observations are available for the requested window."
      : missingEdge
        ? "Available observations do not reach both requested window edges."
        : gapCount
          ? `${gapCount} explicit feed gap${gapCount === 1 ? "" : "s"} occur within the returned observations.`
          : undefined);
  return {
    ...archive,
    status,
    oldestSourceAt: first === undefined ? null : new Date(first).toISOString(),
    newestSourceAt: last === undefined ? null : new Date(last).toISOString(),
    returnedPoints: observations.length,
    observationSpanMs,
    requestedDurationMs,
    missingStartMs,
    missingEndMs,
    gapCount,
    observedPointCount: observations.length,
    measurement: "Elapsed span from earliest to latest real source observation; interior gaps are counted separately and no continuity is implied.",
    ...(reason ? { reason } : {}),
  };
}

/**
 * If a bounded query or output reduction is needed, retain the first, last,
 * minimum, and maximum observation in each time bucket. This does not fill
 * gaps or manufacture values. Snapshot IDs are stable archive-row identities;
 * the existing table does not store Coinbase trade IDs.
 */
export function boundArchivePoints(
  points: readonly ArchivedChartPoint[],
  maxPoints: number,
  startAt: number,
  endAt: number,
): ArchivedChartPoint[] {
  if (points.length <= maxPoints) return [...points].sort((a, b) => a.at - b.at);
  const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
  const bucketWidth = Math.max(1, (endAt - startAt) / bucketCount);
  const buckets = new Map<number, ArchivedChartPoint[]>();
  for (const point of points) {
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor((point.at - startAt) / bucketWidth)));
    const group = buckets.get(bucket) ?? [];
    group.push(point);
    buckets.set(bucket, group);
  }
  const selected = new Map<string, ArchivedChartPoint>();
  Array.from(buckets.values()).forEach((group: ArchivedChartPoint[]) => {
    group.sort((a: ArchivedChartPoint, b: ArchivedChartPoint) =>
      a.at - b.at || (a.archiveId ?? "").localeCompare(b.archiveId ?? ""));
    const candidates = [
      group[0],
      group[group.length - 1],
      group.reduce((minimum, point) => point.price < minimum.price ? point : minimum),
      group.reduce((maximum, point) => point.price > maximum.price ? point : maximum),
    ];
    for (const point of candidates)
      selected.set(point.archiveId ?? `${point.at}:${point.price}`, point);
  });
  return Array.from(selected.values()).sort((a, b) => a.at - b.at);
}

const defaultArchiveQuery: ArchiveQuery = async (sql, values) => {
  const { rows } = await pool.query<ArchiveDbRow>(sql, values as (string | number | Date)[]);
  return { rows };
};

/** Read the provider-stamped tick archive first. Legacy snapshots can only
 * supplement the portion of the requested window before the oldest new tick;
 * they are explicitly identified as sparse legacy observations. */
export async function persistedComparisonArchive(
  windowMinutes: 5 | 15,
  now = Date.now(),
  query: ArchiveQuery = defaultArchiveQuery,
): Promise<PersistedComparisonArchive> {
  const start = now - windowMinutes * 60_000;
  const startAt = new Date(start).toISOString();
  const endAt = new Date(now).toISOString();
  const persistence = comparisonTickPersistenceHealth();
  const baseCoverage = {
    requestedStartAt: startAt,
    requestedEndAt: endAt,
    oldestSourceAt: null,
    newestSourceAt: null,
    returnedPoints: 0,
    truncated: false,
    persistence,
  };
  try {
    const ticks = await query(
      `SELECT id,source_at,received_at,price,source,event_id
         FROM waterx_comparison_ticks
        WHERE source_at >= $1 AND source_at <= $2
        ORDER BY source_at DESC,id DESC
        LIMIT $3`,
      [startAt, endAt, COMPARISON_ARCHIVE_MAX_ROWS + 1],
    );
    const queryTruncated = ticks.rows.length > COMPARISON_ARCHIVE_MAX_ROWS;
    const selectedRows = (queryTruncated ? ticks.rows.slice(0, COMPARISON_ARCHIVE_MAX_ROWS) : ticks.rows)
      .map(row => ({
        at: new Date(row.source_at!).getTime(),
        price: Number(row.price),
        sourceAt: new Date(row.source_at!).toISOString(),
        observedAt: new Date(row.received_at!).toISOString(),
        archiveId: row.event_id ?? row.id,
        ...(row.event_id ? { eventId: row.event_id } : {}),
      }))
      .filter(point => Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0)
      .reverse();
    let rows = selectedRows;
    let legacyUsed = false;
    let legacyTruncated = false;
    let legacyFailure: string | null = null;
    // Legacy snapshots have no exchange event identity and may be sparse. Use
    // them only for a strictly older prefix when new ticks establish the archive
    // boundary; never let them overwrite or fill a newer tick interval.
    const firstTickAt = rows[0]?.at;
    if (firstTickAt !== undefined && firstTickAt > start) {
      try {
        const legacyResult = await query(
          `SELECT id,observed_at,comparison_at,comparison_price
             FROM btc_predict_snapshots
            WHERE comparison_price IS NOT NULL
              AND comparison_at >= $1 AND comparison_at < $2
              AND observed_at >= $3 AND observed_at <= $5
            ORDER BY comparison_at DESC,id DESC
            LIMIT $4`,
          [startAt, new Date(firstTickAt).toISOString(),
            new Date(start - MAX_CAPTURE_AGE_MS).toISOString(), COMPARISON_ARCHIVE_MAX_ROWS + 1, endAt],
        );
        legacyTruncated = legacyResult.rows.length > COMPARISON_ARCHIVE_MAX_ROWS;
        const legacyRows = legacyResult.rows.slice(0, COMPARISON_ARCHIVE_MAX_ROWS)
          .map(row => ({
            at: new Date(row.comparison_at!).getTime(),
            price: Number(row.comparison_price),
            sourceAt: new Date(row.comparison_at!).toISOString(),
            observedAt: new Date(row.observed_at!).toISOString(),
            archiveId: `legacy:${row.id}`,
          }))
          .filter(point => Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0)
          .reverse();
        legacyUsed = legacyRows.length > 0;
        rows = [...legacyRows, ...rows];
      } catch (error) {
        legacyFailure = error instanceof Error ? error.message.slice(0, 120) : "Legacy snapshot read failed";
      }
    }
    const points = boundArchivePoints(
      rows,
      COMPARISON_ARCHIVE_MAX_POINTS,
      start,
      now,
    );
    const truncated = queryTruncated || legacyTruncated || points.length < rows.length || legacyUsed ||
      (rows.length === 0);
    const oldest = points[0]?.sourceAt ?? null;
    const newest = points.at(-1)?.sourceAt ?? null;
    return {
      points,
      coverage: {
        ...baseCoverage,
        status: truncated ? "partial" : "available",
        archiveSource: legacyUsed ? "coinbase_ticks+legacy_snapshots" : "coinbase_ticks",
        oldestSourceAt: oldest,
        newestSourceAt: newest,
        returnedPoints: points.length,
        truncated,
        ...(legacyUsed
          ? { reason: "Legacy snapshot observations supplement only the older prefix before the first Coinbase tick; that prefix may be sparse and is not a complete archive." }
          : legacyFailure
            ? { reason: `Coinbase ticks are available, but legacy historical prefix lookup failed: ${legacyFailure}` }
          : rows.length === 0
            ? { reason: "No persisted Coinbase comparison ticks are available in this window." }
            : queryTruncated
          ? { reason: `Archive exceeded the ${COMPARISON_ARCHIVE_MAX_ROWS} row read cap; oldest matching observations may be omitted.` }
          : points.length < rows.length
            ? { reason: `Archive was time-bucketed to at most ${COMPARISON_ARCHIVE_MAX_POINTS} points; source extrema and interval edges were retained.` }
            : {}),
      },
    };
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") {
      // Rollout safety: a still-unmigrated production database must not lose
      // its formerly readable chart while the additive migration is pending.
      try {
        const legacy = await query(
          `SELECT id,observed_at,comparison_at,comparison_price
             FROM btc_predict_snapshots
            WHERE comparison_price IS NOT NULL AND comparison_at >= $1 AND comparison_at <= $2
              AND observed_at >= $3 AND observed_at <= $2
            ORDER BY comparison_at DESC,id DESC LIMIT $4`,
          [startAt, endAt, new Date(start - MAX_CAPTURE_AGE_MS).toISOString(),
            COMPARISON_ARCHIVE_MAX_ROWS + 1],
        );
        const truncated = legacy.rows.length > COMPARISON_ARCHIVE_MAX_ROWS;
        const points = boundArchivePoints(legacy.rows.slice(0, COMPARISON_ARCHIVE_MAX_ROWS)
          .map(row => ({
            at: new Date(row.comparison_at!).getTime(),
            price: Number(row.comparison_price),
            sourceAt: new Date(row.comparison_at!).toISOString(),
            observedAt: new Date(row.observed_at!).toISOString(),
            archiveId: `legacy:${row.id}`,
          }))
          .filter(point => Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0)
          .reverse(), COMPARISON_ARCHIVE_MAX_POINTS, start, now);
        return {
          points,
          coverage: {
            ...baseCoverage,
            status: "partial",
            archiveSource: "legacy_snapshots",
            oldestSourceAt: points[0]?.sourceAt ?? null,
            newestSourceAt: points.at(-1)?.sourceAt ?? null,
            returnedPoints: points.length,
            truncated,
            reason: "Tick archive schema is not installed. Sparse legacy snapshots only; gaps and missing rounds are not backfilled.",
          },
        };
      } catch {
        // Fall through to the explicit archive-unavailable response below.
      }
    }
    return {
      points: [],
      coverage: {
        ...baseCoverage,
        status: "unavailable",
        persistence: comparisonTickPersistenceHealth(),
        reason: error instanceof Error
          ? `Comparison archive unavailable: ${error.message.slice(0, 160)}`
          : "Comparison archive unavailable because the database read failed.",
      },
    };
  }
}

/**
 * Backward-compatible points-only API. New route/client consumers should use
 * persistedComparisonArchive to surface the explicit coverage result.
 */
export async function persistedComparisonHistory(windowMinutes: 5 | 15): Promise<ArchivedChartPoint[]> {
  return (await persistedComparisonArchive(windowMinutes)).points;
}