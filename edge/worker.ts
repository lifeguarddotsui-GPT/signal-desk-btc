import {
  getCurrentWaterxRound,
  parseWaterxResponse,
  verifiedHistoricalRound,
  type CurrentRoundResult,
} from "../server/waterx/source";
import type { WaterxInterval, WaterxRound } from "../server/waterx/types";

const POLL_MS = 5_000;
const SNAPSHOT_MS = 30_000;
const SETTLEMENT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const TRIAL_WINDOW_MS = 26 * 60 * 60_000;
const SETTLEMENT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_CATCHUP_ROUNDS = { 5: 289, 15: 97 } as const;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const ALARMS_PER_DAY = 24 * 60 * 60_000 / POLL_MS;
const CRONS_PER_DAY = 24 * 60;
const DO_STATE_ROW_WRITES_PER_DAY_BOUND = ALARMS_PER_DAY + CRONS_PER_DAY;
const DO_STORAGE_WRITES_PER_DAY_BOUND = 2 * DO_STATE_ROW_WRITES_PER_DAY_BOUND;
const COVERAGE_CACHE_MS = 5 * 60_000;
const intervals: readonly WaterxInterval[] = [5, 15];
const STATE_KEY = "collectorState";
let coverageCache: { expiresAtMs: number; body: string } | null = null;

type SqlResult = {
  meta?: { rows_read?: number; rows_written?: number; changes?: number };
};
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<SqlResult>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: SqlResult["meta"] }>;
};
type D1Database = { prepare(query: string): D1Statement };
type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};
type DurableState = { storage: Storage };
type Environment = {
  DB: D1Database;
  WATERX_COLLECTOR: DurableObjectNamespace;
};
type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type IntervalHealth = {
  intervalMinutes: WaterxInterval;
  status: string;
  roundId: string | null;
  observedAt: number | null;
  lastAttemptAt: number | null;
  scheduledAt: number | null;
  freshnessAgeMs: number | null;
  scheduledDelayMs: number | null;
  maxFreshnessAgeMs: number;
  maxScheduledDelayMs: number;
  lastError: string | null;
  d1Error: string | null;
  settlementError: string | null;
  retries: number;
  nextRetryAt: number | null;
};
type StoredRound = {
  intervalMinutes: WaterxInterval;
  roundId: string;
  marketId: string;
  startsAtMs: number;
  endsAtMs: number;
  observedAtMs: number;
  scheduledAtMs: number;
  upProbabilityCents: number | null;
  downProbabilityCents: number | null;
  upOddsCents: number | null;
  downOddsCents: number | null;
  referencePrice: number | null;
  referenceConfirmed: boolean;
  source: "WaterX";
};
type CollectorState = {
  startedAtMs: number | null;
  nextScheduledAt: number | null;
  lastScheduledAlarmAt: number | null;
  tick: number;
  lastSettlementPassAt: number;
  lastPruneAt: number;
  d1Usage: { rowsRead: number; rowsWritten: number };
  health: Partial<Record<WaterxInterval, IntervalHealth>>;
  latest: Partial<Record<WaterxInterval, StoredRound>>;
  coverageRound: Partial<Record<WaterxInterval, number>>;
  roundFirstPersisted: Partial<Record<WaterxInterval, { roundId: string; endsAtMs: number }>>;
  snapshotBuckets: Partial<Record<WaterxInterval, { roundId: string; bucketMs: number }>>;
  settlementCursor: Partial<Record<WaterxInterval, number>>;
  settlementError: Partial<Record<WaterxInterval, string>>;
  roundHadGap?: Partial<Record<WaterxInterval, { roundId: string; hadGap: boolean }>>;
  coverageFlushedRounds?: Partial<Record<WaterxInterval, string>>;
  trialStoppedAtMs?: number | null;
};

function emptyState(): CollectorState {
  return {
    startedAtMs: null,
    nextScheduledAt: null,
    lastScheduledAlarmAt: null,
    tick: 0,
    lastSettlementPassAt: 0,
    lastPruneAt: 0,
    d1Usage: { rowsRead: 0, rowsWritten: 0 },
    health: {},
    latest: {},
    coverageRound: {},
    roundFirstPersisted: {},
    snapshotBuckets: {},
    settlementCursor: {},
    settlementError: {},
    roundHadGap: {},
    coverageFlushedRounds: {},
    trialStoppedAtMs: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "Unknown collector failure";
}

function retryDelay(attempts: number, providerDelay: number | null = null): number {
  return Math.min(MAX_RETRY_MS, Math.max(
    providerDelay ?? 0,
    POLL_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 4),
  ));
}

function toStoredRound(
  interval: WaterxInterval,
  result: CurrentRoundResult,
  scheduledAtMs: number,
  observedAtMs: number,
): StoredRound {
  const round = result.detail.round;
  return {
    intervalMinutes: interval,
    roundId: round.id,
    marketId: round.marketId,
    startsAtMs: round.startsAt * 1_000,
    endsAtMs: round.endsAt * 1_000,
    observedAtMs,
    scheduledAtMs,
    upProbabilityCents: round.sides.up.probabilityCents,
    downProbabilityCents: round.sides.down.probabilityCents,
    upOddsCents: round.sides.up.oddsCents,
    downOddsCents: round.sides.down.oddsCents,
    referencePrice: round.anchorPrice,
    referenceConfirmed: round.anchorPriceConfirmed,
    source: "WaterX",
  };
}

export class WaterxCollector {
  private readonly ctx: DurableState;
  private readonly env: Environment;
  private alarmInProgress = false;

  constructor(ctx: DurableState, env: Environment) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = await this.loadState();
    if (url.pathname === "/bootstrap" && request.method === "POST") {
      const nowMs = Date.now();
      if (this.alarmInProgress) {
        return json({
          ok: true, alarmAt: state.nextScheduledAt,
          trialStatus: this.trialStatus(state, nowMs),
          startedAtMs: state.startedAtMs,
          stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
        });
      }
      if (state.startedAtMs !== null && nowMs >= state.startedAtMs + TRIAL_WINDOW_MS) {
        await this.stopTrial(state, nowMs);
        return json({
          ok: true, alarmAt: null, trialStatus: "STOPPED",
          startedAtMs: state.startedAtMs, stopsAtMs: state.startedAtMs + TRIAL_WINDOW_MS,
        });
      }
      if (state.trialStoppedAtMs != null) {
        await this.ctx.storage.deleteAlarm();
        return json({
          ok: true, alarmAt: null, trialStatus: "STOPPED",
          startedAtMs: state.startedAtMs,
          stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
        });
      }
      const alarm = await this.ctx.storage.getAlarm();
      if (this.alarmInProgress) {
        return json({
          ok: true, alarmAt: state.nextScheduledAt,
          trialStatus: this.trialStatus(state, nowMs),
          startedAtMs: state.startedAtMs,
          stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
        });
      }
      if (alarm !== null && state.startedAtMs === null) {
        state.startedAtMs = nowMs;
        state.nextScheduledAt ??= alarm;
        await this.saveState(state);
      }
      if (alarm === null) {
        const scheduledAt = nowMs;
        state.startedAtMs ??= scheduledAt;
        state.nextScheduledAt = scheduledAt;
        await this.saveState(state);
        await this.ctx.storage.setAlarm(scheduledAt);
      }
      return json({
        ok: true, alarmAt: await this.ctx.storage.getAlarm(),
        trialStatus: this.trialStatus(state, nowMs), startedAtMs: state.startedAtMs,
        stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
      });
    }
    if (url.pathname === "/coverage") return this.coverageResponse(state, Date.now());
    if (url.pathname !== "/health" && url.pathname !== "/latest") return json({ error: "Not found" }, 404);

    const health = intervals.map(interval => {
      const saved = state.health[interval];
      return saved ? {
        ...saved,
        freshnessAgeMs: saved.observedAt === null ? null : Math.max(0, Date.now() - saved.observedAt),
      } : {
        intervalMinutes: interval, status: "WAITING", roundId: null, observedAt: null,
        lastAttemptAt: null, scheduledAt: null, freshnessAgeMs: null, scheduledDelayMs: null,
        maxFreshnessAgeMs: 0, maxScheduledDelayMs: 0,
        lastError: null, d1Error: null, settlementError: null, retries: 0, nextRetryAt: null,
      } satisfies IntervalHealth;
    });
    return json({
      mode: "source-only-cloudflare-free-prototype",
      browserRequired: false,
      trialStatus: this.trialStatus(state, Date.now()),
      startedAtMs: state.startedAtMs,
      stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
      lastScheduledAlarmAt: state.lastScheduledAlarmAt,
      nextScheduledAt: state.nextScheduledAt,
      alarmAt: await this.ctx.storage.getAlarm(),
      health,
      latest: url.pathname === "/latest" ? intervals.map(i => state.latest[i]).filter(Boolean) : undefined,
      d1UsageSinceStart: state.d1Usage,
      durableObjectStorageWriteUpperBound24h: {
        alarmInvocations: ALARMS_PER_DAY,
        cronInvocations: CRONS_PER_DAY,
        aggregateStateRowsWritten: DO_STATE_ROW_WRITES_PER_DAY_BOUND,
        setAlarmWrites: DO_STATE_ROW_WRITES_PER_DAY_BOUND,
        includingSetAlarmWrites: DO_STORAGE_WRITES_PER_DAY_BOUND,
        basis: "nominal schedule, with every cron assumed to find the alarm missing",
        excludesAtLeastOnceRedeliveries: true,
      },
    });
  }

  private async coverageResponse(state: CollectorState, nowMs: number): Promise<Response> {
    const frozenWindowEndMs = state.trialStoppedAtMs ?? null;
    if (coverageCache && coverageCache.expiresAtMs > nowMs &&
        (frozenWindowEndMs === null || JSON.parse(coverageCache.body).windowEndMs === frozenWindowEndMs)) {
      const cached = JSON.parse(coverageCache.body) as Record<string, unknown>;
      cached.trialStatus = this.trialStatus(state, nowMs);
      cached.startedAtMs = state.startedAtMs;
      cached.stopsAtMs = state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS;
      return new Response(JSON.stringify(cached), {
        headers: { "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300" },
      });
    }
    const windowEndMs = frozenWindowEndMs ?? nowMs;
    const windowStartMs = windowEndMs - 24 * 60 * 60_000;
    try {
      const [coverage, samples, settlements] = await Promise.all([
        this.env.DB.prepare(
          `SELECT interval_minutes AS intervalMinutes, COUNT(*) AS expectedRounds,
                  SUM(CASE WHEN first_success_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS successfulRounds,
                  SUM(had_gap) AS gapRounds, MAX(max_freshness_age_ms) AS maxFreshnessAgeMs,
                  MAX(max_scheduled_delay_ms) AS maxScheduledDelayMs
             FROM waterx_edge_coverage
            WHERE expected_round_start_ms >= ? AND expected_round_start_ms <= ?
            GROUP BY interval_minutes`,
         ).bind(windowStartMs, windowEndMs).all<Record<string, number>>(),
        this.env.DB.prepare(
          `SELECT interval_minutes AS intervalMinutes, COUNT(*) AS sampleCount,
                  SUM(CASE WHEN up_probability_cents IS NULL THEN 1 ELSE 0 END) AS upProbabilityMissing,
                  SUM(CASE WHEN down_probability_cents IS NULL THEN 1 ELSE 0 END) AS downProbabilityMissing,
                  SUM(CASE WHEN up_odds_cents IS NULL THEN 1 ELSE 0 END) AS upOddsMissing,
                  SUM(CASE WHEN down_odds_cents IS NULL THEN 1 ELSE 0 END) AS downOddsMissing,
                  SUM(CASE WHEN reference_price IS NULL THEN 1 ELSE 0 END) AS referenceMissing,
                  SUM(CASE WHEN reference_confirmed = 0 THEN 1 ELSE 0 END) AS referenceUnconfirmed
             FROM waterx_snapshots
            WHERE observed_at_ms >= ? AND observed_at_ms <= ?
            GROUP BY interval_minutes`,
         ).bind(windowStartMs, windowEndMs).all<Record<string, number>>(),
        this.env.DB.prepare(
          `SELECT interval_minutes AS intervalMinutes, COUNT(*) AS attempts,
                  SUM(CASE WHEN verdict = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
                  SUM(CASE WHEN verdict = 'WITHHELD' THEN 1 ELSE 0 END) AS withheld,
                  SUM(CASE WHEN verdict = 'IDENTITY_MISMATCH' THEN 1 ELSE 0 END) AS identityMismatch,
                  SUM(CASE WHEN verdict = 'READ_ERROR' THEN 1 ELSE 0 END) AS readErrors
             FROM waterx_settlement_evidence
            WHERE observed_at_ms >= ? AND observed_at_ms <= ?
            GROUP BY interval_minutes`,
         ).bind(windowStartMs, windowEndMs).all<Record<string, number>>(),
      ]);
      const coverageByInterval = new Map(coverage.results.map(row => [row.intervalMinutes, row]));
      const samplesByInterval = new Map(samples.results.map(row => [row.intervalMinutes, row]));
      const settlementsByInterval = new Map(settlements.results.map(row => [row.intervalMinutes, row]));
      const intervalsSummary = intervals.map(interval => {
        const expected = coverageByInterval.get(interval);
        const sample = samplesByInterval.get(interval);
        const settlement = settlementsByInterval.get(interval);
        const duration = interval * 60_000;
        const requiredRounds = Math.max(0,
          Math.floor(windowEndMs / duration) - Math.ceil(windowStartMs / duration) + 1);
        const expectedRounds = Number(expected?.expectedRounds ?? 0);
        const windowElapsed = state.startedAtMs !== null &&
          state.startedAtMs <= windowStartMs;
        const accountingComplete = windowElapsed && expectedRounds >= requiredRounds;
        const gapRounds = Number(expected?.gapRounds ?? 0);
        return {
          intervalMinutes: interval,
          requiredRounds,
          expectedRounds,
          successfulRounds: Number(expected?.successfulRounds ?? 0),
          gapRounds,
          gapFree: accountingComplete && gapRounds === 0 &&
            Number(expected?.successfulRounds ?? 0) >= requiredRounds,
          accountingComplete,
          maxFreshnessAgeMs: expected?.maxFreshnessAgeMs ?? null,
          maxScheduledDelayMs: expected?.maxScheduledDelayMs ?? null,
          samples: {
            count: Number(sample?.sampleCount ?? 0),
            upProbabilityMissing: Number(sample?.upProbabilityMissing ?? 0),
            downProbabilityMissing: Number(sample?.downProbabilityMissing ?? 0),
            upOddsMissing: Number(sample?.upOddsMissing ?? 0),
            downOddsMissing: Number(sample?.downOddsMissing ?? 0),
            referenceMissing: Number(sample?.referenceMissing ?? 0),
            referenceUnconfirmed: Number(sample?.referenceUnconfirmed ?? 0),
          },
          settlement: {
            attempts: Number(settlement?.attempts ?? 0),
            verified: Number(settlement?.verified ?? 0),
            withheld: Number(settlement?.withheld ?? 0),
            identityMismatch: Number(settlement?.identityMismatch ?? 0),
            readErrors: Number(settlement?.readErrors ?? 0),
          },
        };
      });
      const body = JSON.stringify({
        mode: "source-only-cloudflare-free-prototype",
        calculatedAtMs: nowMs,
        windowStartMs, windowEndMs, windowMs: 24 * 60 * 60_000,
        collectionStartedAtMs: state.startedAtMs,
        trialStatus: this.trialStatus(state, nowMs),
        startedAtMs: state.startedAtMs,
        stopsAtMs: state.startedAtMs === null ? null : state.startedAtMs + TRIAL_WINDOW_MS,
        cacheTtlMs: COVERAGE_CACHE_MS,
        full24hElapsed: state.startedAtMs !== null && state.startedAtMs <= windowStartMs,
        complete: intervalsSummary.every(item => item.accountingComplete),
        intervals: intervalsSummary,
        d1RowsReadForCalculation: [coverage, samples, settlements]
          .reduce((sum, result) => sum + (result.meta?.rows_read ?? 0), 0),
        boundedCatchupRounds: MAX_CATCHUP_ROUNDS,
        durableObjectStorageWriteUpperBound24h: {
          aggregateStateRowsWritten: DO_STATE_ROW_WRITES_PER_DAY_BOUND,
          includingSetAlarmWrites: DO_STORAGE_WRITES_PER_DAY_BOUND,
          basis: "nominal schedule, with every cron assumed to find the alarm missing",
          excludesAtLeastOnceRedeliveries: true,
        },
        note: "Completion means the full 24h window is accounted for, not that it is gap-free. The 5m in-isolate cache is best-effort; cold starts or multiple instances can increase D1 reads.",
      });
      coverageCache = { expiresAtMs: nowMs + COVERAGE_CACHE_MS, body };
      return new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300" },
      });
    } catch (error) {
      return json({ error: "D1 24h coverage query failed", detail: errorMessage(error) }, 503);
    }
  }

  async alarm(): Promise<void> {
    if (this.alarmInProgress) return;
    this.alarmInProgress = true;
    try {
      const state = await this.loadState();
      const firedAtMs = Date.now();
      state.startedAtMs ??= firedAtMs;
      if (state.trialStoppedAtMs != null || firedAtMs >= state.startedAtMs + TRIAL_WINDOW_MS) {
        await this.stopTrial(state, firedAtMs);
        return;
      }
      const scheduledAtMs = state.nextScheduledAt ?? firedAtMs;
      state.lastScheduledAlarmAt = firedAtMs;
      const tick = state.tick;
      state.tick += 1;
      const due = intervals.filter(interval => interval === 5 || tick % 2 === 0);

      try {
        await Promise.all(due.map(interval =>
          this.pollInterval(interval, state, scheduledAtMs, firedAtMs)));
        if (firedAtMs - state.lastSettlementPassAt >= SETTLEMENT_RETRY_MS) {
          state.lastSettlementPassAt = firedAtMs;
          await Promise.all(intervals.map(async interval => {
            try {
              await this.finalizeCoverage(interval, state, firedAtMs);
            } catch (error) {
              this.saveDatabaseError(interval, state, error);
            }
            await this.reconcileSettlement(interval, state, firedAtMs);
          }));
        }
        if (firedAtMs - state.lastPruneAt >= 24 * 60 * 60_000) {
          state.lastPruneAt = firedAtMs;
          try {
            await this.pruneOldSnapshots(state, firedAtMs);
          } catch (error) {
            this.saveDatabaseError(5, state, error);
          }
        }
      } finally {
        // Always reschedule, including if the provider or D1 throws. Do not fire
        // a burst of missed alarms after an outage.
        const rescheduledAt = Date.now() + POLL_MS;
        if (rescheduledAt >= state.startedAtMs + TRIAL_WINDOW_MS) {
          await this.stopTrial(state, rescheduledAt);
        } else {
          state.nextScheduledAt = rescheduledAt;
          await this.saveState(state);
          await this.ctx.storage.setAlarm(rescheduledAt);
        }
      }
    } finally {
      this.alarmInProgress = false;
    }
  }

  private async pollInterval(
    interval: WaterxInterval,
    state: CollectorState,
    scheduledAtMs: number,
    firedAtMs: number,
  ): Promise<void> {
    const previous = state.health[interval];
    const roundDurationMs = interval * 60_000;
    const expectedStartMs = Math.floor(firedAtMs / roundDurationMs) * roundDurationMs;
    let coverageError: string | null = null;
    try {
      await this.recordExpectedRounds(interval, state, expectedStartMs);
    } catch (error) {
      coverageError = errorMessage(error);
      this.saveDatabaseError(interval, state, error);
    }
    if (previous?.nextRetryAt && previous.nextRetryAt > firedAtMs) return;

    try {
      const result = await getCurrentWaterxRound(interval);
      const observedAtMs = Date.now();
      if (result.status !== "LIVE") {
        const health: IntervalHealth = {
          intervalMinutes: interval, status: result.status, roundId: previous?.roundId ?? null,
          observedAt: previous?.observedAt ?? null, lastAttemptAt: observedAtMs,
          scheduledAt: scheduledAtMs,
          freshnessAgeMs: previous?.observedAt == null
            ? null : Math.max(0, observedAtMs - previous.observedAt),
          scheduledDelayMs: Math.max(0, firedAtMs - scheduledAtMs),
          maxFreshnessAgeMs: previous?.maxFreshnessAgeMs ?? 0,
          maxScheduledDelayMs: previous?.maxScheduledDelayMs ?? 0,
          lastError: null, d1Error: coverageError ?? previous?.d1Error ?? null,
          settlementError: state.settlementError[interval] ?? null,
          retries: 0, nextRetryAt: null,
        };
        state.health[interval] = health;
        return;
      }

      const round = toStoredRound(interval, result, scheduledAtMs, observedAtMs);
      const sameRound = previous?.roundId === round.roundId;
      const priorRound = state.latest[interval];
      const freshnessGapMs = previous?.observedAt != null
        ? Math.max(0, observedAtMs - previous.observedAt) : 0;
      const thresholdMs = interval === 5 ? 15_000 : 30_000;
      const crossRoundFreshnessGapMs = priorRound && priorRound.roundId !== round.roundId
        ? freshnessGapMs : 0;
      let rolloverError: string | null = null;
      if (priorRound && priorRound.roundId !== round.roundId) {
        state.roundHadGap ??= {};
        if (crossRoundFreshnessGapMs > thresholdMs)
          state.roundHadGap[interval] = { roundId: priorRound.roundId, hadGap: true };
        try {
          await this.persistSnapshot(
            priorRound, state,
            Math.max(previous?.maxFreshnessAgeMs ?? 0, crossRoundFreshnessGapMs),
            previous?.maxScheduledDelayMs ?? 0,
            state.roundHadGap?.[interval]?.roundId === priorRound.roundId &&
              state.roundHadGap[interval]!.hadGap,
            true,
          );
          state.coverageFlushedRounds ??= {};
          state.coverageFlushedRounds[interval] = priorRound.roundId;
        } catch (error) {
          rolloverError = errorMessage(error);
        }
      }
      const firstObservationOfRound = priorRound?.roundId !== round.roundId;
      const scheduledDelayMs = Math.max(0, firedAtMs - scheduledAtMs);
      const maxFreshnessAgeMs = sameRound
        ? Math.max(previous?.maxFreshnessAgeMs ?? 0, freshnessGapMs) : freshnessGapMs;
      const maxScheduledDelayMs = sameRound
        ? Math.max(previous?.maxScheduledDelayMs ?? 0, scheduledDelayMs) : scheduledDelayMs;
      const previousGap = state.roundHadGap?.[interval];
      const hadGap = (sameRound && previousGap?.roundId === round.roundId && previousGap.hadGap) ||
        freshnessGapMs > thresholdMs ||
        (firstObservationOfRound && round.observedAtMs - round.startsAtMs > thresholdMs);
      state.roundHadGap ??= {};
      state.roundHadGap[interval] = { roundId: round.roundId, hadGap };
      // This SQLite-backed DO copy is always updated first. D1 problems must
      // not roll back the live read, block the next alarm, or lose its identity.
      state.latest[interval] = round;
      let d1Error: string | null = coverageError;
      try {
        await this.persistSnapshot(round, state, maxFreshnessAgeMs, maxScheduledDelayMs, hadGap);
        d1Error = rolloverError;
      } catch (error) {
        d1Error = errorMessage(error);
      }
      const health: IntervalHealth = {
        intervalMinutes: interval, status: "LIVE", roundId: round.roundId,
        observedAt: observedAtMs, lastAttemptAt: observedAtMs,
        scheduledAt: scheduledAtMs, freshnessAgeMs: 0,
        scheduledDelayMs, maxFreshnessAgeMs, maxScheduledDelayMs,
        lastError: null, d1Error, settlementError: state.settlementError[interval] ?? null,
        retries: 0, nextRetryAt: null,
      };
      state.health[interval] = health;
    } catch (error) {
      const message = errorMessage(error);
      const providerDelay = typeof error === "object" && error !== null &&
        "retryAfterMs" in error && typeof error.retryAfterMs === "number" ? error.retryAfterMs : null;
      const attempts = (previous?.retries ?? 0) + 1;
      const nextRetryAt = Date.now() + retryDelay(attempts, providerDelay);
      const health: IntervalHealth = {
        intervalMinutes: interval, status: "UNAVAILABLE",
        roundId: previous?.roundId ?? null, observedAt: previous?.observedAt ?? null,
        lastAttemptAt: Date.now(),
        scheduledAt: scheduledAtMs,
        freshnessAgeMs: previous?.observedAt === null || previous?.observedAt === undefined
          ? null : Math.max(0, Date.now() - previous.observedAt),
        scheduledDelayMs: Math.max(0, firedAtMs - scheduledAtMs),
        maxFreshnessAgeMs: previous?.maxFreshnessAgeMs ?? 0,
        maxScheduledDelayMs: previous?.maxScheduledDelayMs ?? 0,
        lastError: message, d1Error: coverageError ?? previous?.d1Error ?? null,
        settlementError: state.settlementError[interval] ?? null,
        retries: attempts, nextRetryAt,
      };
      state.health[interval] = health;
    }
  }

  private async recordExpectedRounds(
    interval: WaterxInterval,
    state: CollectorState,
    expectedStartMs: number,
  ): Promise<void> {
    const durationMs = interval * 60_000;
    const prior = state.coverageRound[interval];
    if (prior === expectedStartMs) return;
    const firstFromPrior = prior === undefined
      ? expectedStartMs
      : prior + durationMs;
    const catchupCap = MAX_CATCHUP_ROUNDS[interval];
    const oldestKept = expectedStartMs - (catchupCap - 1) * durationMs;
    const catchupStart = Math.max(firstFromPrior, oldestKept);
    const startMs = Math.min(catchupStart, expectedStartMs);
    const count = Math.floor((expectedStartMs - startMs) / durationMs) + 1;
    const sql = `WITH RECURSIVE expected(start_ms) AS (
        SELECT ?
        UNION ALL SELECT start_ms + ? FROM expected WHERE start_ms + ? <= ?
        LIMIT ?
      )
      INSERT OR IGNORE INTO waterx_edge_coverage
       (interval_minutes, expected_round_start_ms, expected_round_id,
        first_success_at_ms, last_success_at_ms, max_freshness_age_ms,
        max_scheduled_delay_ms, had_gap)
      SELECT ?, start_ms, NULL, NULL, NULL, NULL, NULL,
              CASE WHEN start_ms < ? THEN 1 ELSE 0 END
        FROM expected`;
    await this.run(state, sql, startMs, durationMs, durationMs, expectedStartMs,
      count, interval, expectedStartMs);
    state.coverageRound[interval] = expectedStartMs;
  }

  private async persistSnapshot(
    round: StoredRound,
    state: CollectorState,
    maxFreshnessAgeMs: number,
    maxScheduledDelayMs: number,
    hadGap: boolean,
    forceCoverage = false,
  ): Promise<void> {
    const firstRecord = state.roundFirstPersisted[round.intervalMinutes];
    if (firstRecord?.roundId !== round.roundId) {
      await this.run(state,
        `INSERT OR IGNORE INTO waterx_round_first
         (interval_minutes, round_id, market_id, round_starts_at_ms, round_ends_at_ms,
          first_observed_at_ms, up_probability_cents, down_probability_cents, up_odds_cents,
          down_odds_cents, reference_price, reference_confirmed, quote_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WaterX')`,
        round.intervalMinutes, round.roundId, round.marketId, round.startsAtMs, round.endsAtMs,
        round.observedAtMs, round.upProbabilityCents, round.downProbabilityCents,
        round.upOddsCents, round.downOddsCents, round.referencePrice, Number(round.referenceConfirmed),
      );
      await this.run(state,
        `INSERT OR IGNORE INTO waterx_settlement_pending
         (interval_minutes, round_id, round_ends_at_ms) VALUES (?, ?, ?)`,
        round.intervalMinutes, round.roundId, round.endsAtMs,
      );
      state.roundFirstPersisted[round.intervalMinutes] = {
        roundId: round.roundId, endsAtMs: round.endsAtMs,
      };
    }
    const bucketMs = Math.floor(round.observedAtMs / SNAPSHOT_MS) * SNAPSHOT_MS;
    const previousBucket = state.snapshotBuckets[round.intervalMinutes];
    const newBucket = !previousBucket || previousBucket.roundId !== round.roundId ||
      previousBucket.bucketMs !== bucketMs;
    if (newBucket) await this.run(state,
      `INSERT OR IGNORE INTO waterx_snapshots
       (interval_minutes, round_id, observed_bucket_ms, observed_at_ms, scheduled_at_ms,
        up_probability_cents, down_probability_cents, up_odds_cents, down_odds_cents,
        reference_price, reference_confirmed, round_starts_at_ms, round_ends_at_ms, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WaterX')`,
      round.intervalMinutes, round.roundId, bucketMs, round.observedAtMs, round.scheduledAtMs,
      round.upProbabilityCents, round.downProbabilityCents, round.upOddsCents,
      round.downOddsCents, round.referencePrice, Number(round.referenceConfirmed),
      round.startsAtMs, round.endsAtMs,
    );
    if (newBucket || forceCoverage) await this.run(state,
      `INSERT INTO waterx_edge_coverage
       (interval_minutes, expected_round_start_ms, expected_round_id, first_success_at_ms,
        last_success_at_ms, max_freshness_age_ms, max_scheduled_delay_ms, had_gap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(interval_minutes, expected_round_start_ms) DO UPDATE SET
         expected_round_id=excluded.expected_round_id,
         first_success_at_ms=COALESCE(waterx_edge_coverage.first_success_at_ms, excluded.first_success_at_ms),
         last_success_at_ms=excluded.last_success_at_ms,
         max_freshness_age_ms=MAX(COALESCE(waterx_edge_coverage.max_freshness_age_ms, 0),
                                  excluded.max_freshness_age_ms),
         max_scheduled_delay_ms=MAX(COALESCE(waterx_edge_coverage.max_scheduled_delay_ms, 0),
                                    excluded.max_scheduled_delay_ms),
         had_gap=MAX(waterx_edge_coverage.had_gap, excluded.had_gap)`,
      round.intervalMinutes, round.startsAtMs, round.roundId, round.observedAtMs,
      round.observedAtMs,
      maxFreshnessAgeMs, maxScheduledDelayMs,
        hadGap ? 1 : 0,
    );
    if (newBucket) state.snapshotBuckets[round.intervalMinutes] = { roundId: round.roundId, bucketMs };
  }

  private async reconcileSettlement(
    interval: WaterxInterval,
    state: CollectorState,
    nowMs: number,
  ): Promise<void> {
    const probeBucketMs = Math.floor(nowMs / SETTLEMENT_RETRY_MS) * SETTLEMENT_RETRY_MS;
    let candidate: { roundId: string; endsAtMs: number; marketId: string } | undefined;
    try {
      candidate = await this.findSettlementCandidate(interval, state, nowMs, probeBucketMs);
    } catch (error) {
      this.saveDatabaseError(interval, state, error);
      return;
    }
    if (!candidate) return;
    const expectedEnd = candidate.endsAtMs / 1_000;
    let detail;
    try {
      detail = await this.readHistorical(interval, expectedEnd);
    } catch (error) {
      state.settlementError[interval] = errorMessage(error);
      if (state.health[interval]) state.health[interval] = {
        ...state.health[interval]!, settlementError: state.settlementError[interval]!,
      };
      try {
        await this.writeSettlementEvidence(state, {
          interval, expectedRoundId: candidate.roundId, probeBucketMs, observedAtMs: nowMs,
          expectedEnd, providerRoundId: null, providerEnd: null,
          status: null, outcome: null, settledAt: null, settlePrice: null, anchorPrice: null,
          anchorConfirmed: false, verdict: "READ_ERROR", reason: errorMessage(error),
        });
        state.settlementCursor[interval] = candidate.endsAtMs;
      } catch (d1Error) {
        this.saveDatabaseError(interval, state, d1Error);
      }
      return;
    }

    const round: WaterxRound = detail.round;
    let verdict: "VERIFIED" | "WITHHELD" | "IDENTITY_MISMATCH" = "WITHHELD";
    let reason: string | null = null;
    try {
      verifiedHistoricalRound(detail, candidate.roundId, expectedEnd);
      if (detail.market.marketId !== candidate.marketId)
        throw new Error("WaterX historical market differs from the frozen prospective market.");
    } catch (error) {
      verdict = "IDENTITY_MISMATCH";
      reason = errorMessage(error);
    }
    const status = round.resolutionStatus?.trim().toLowerCase() ?? null;
    const outcome = round.settlement?.outcome?.trim().toLowerCase() ?? null;
    const settledAt = round.settlement?.settledAt ?? null;
    if (verdict !== "IDENTITY_MISMATCH") {
      if (status !== "resolved") reason = "WaterX has not explicitly resolved this round.";
      else if (outcome !== "up" && outcome !== "down")
        reason = "WaterX provider outcome is absent or invalid; no outcome inferred.";
      else if (settledAt === null || settledAt <= expectedEnd ||
               settledAt > Math.floor(nowMs / 1_000))
        reason = "WaterX settlement timestamp must be post-expiry and no later than observation.";
      else if (round.settlePrice === null || !Number.isFinite(round.settlePrice) || round.settlePrice <= 0)
        reason = "WaterX settlement price is absent or invalid.";
      else if (!round.anchorPriceConfirmed || round.anchorPrice === null)
        reason = "WaterX settlement anchor is absent or unconfirmed.";
      else if ((outcome === "up") !== (round.settlePrice >= round.anchorPrice))
        reason = "WaterX outcome contradicts its settlement price and confirmed anchor.";
      else verdict = "VERIFIED";
    }
    try {
      await this.writeSettlementEvidence(state, {
        interval, expectedRoundId: candidate.roundId, probeBucketMs, observedAtMs: nowMs,
        expectedEnd, providerRoundId: round.id,
        providerEnd: round.endsAt, status, outcome, settledAt, settlePrice: round.settlePrice,
        anchorPrice: round.anchorPrice, anchorConfirmed: round.anchorPriceConfirmed,
        verdict, reason,
      });
      if (verdict === "VERIFIED") {
        await this.run(state,
          "DELETE FROM waterx_settlement_pending WHERE interval_minutes = ? AND round_id = ?",
          interval, candidate.roundId);
      }
      state.settlementCursor[interval] = candidate.endsAtMs;
      delete state.settlementError[interval];
      if (state.health[interval]) state.health[interval] = {
        ...state.health[interval]!, settlementError: null,
      };
    } catch (error) {
      this.saveDatabaseError(interval, state, error);
    }
  }

  private async findSettlementCandidate(
    interval: WaterxInterval,
    state: CollectorState,
    nowMs: number,
    probeBucketMs: number,
  ): Promise<{ roundId: string; endsAtMs: number; marketId: string } | undefined> {
    const cursor = state.settlementCursor[interval] ?? 0;
    const query = async (afterEndMs: number, throughEndMs: number | null) => {
       let sql = `SELECT p.round_id AS roundId, p.round_ends_at_ms AS endsAtMs,
                        r.market_id AS marketId
          FROM waterx_settlement_pending AS p
           JOIN waterx_round_first AS r ON r.interval_minutes = p.interval_minutes
                                        AND r.round_id = p.round_id
         WHERE p.interval_minutes = ? AND p.round_ends_at_ms <= ? AND p.round_ends_at_ms >= ?
           AND p.round_ends_at_ms > ?`;
      const values: unknown[] = [
        interval, nowMs, nowMs - SETTLEMENT_LOOKBACK_MS, afterEndMs,
      ];
      if (throughEndMs !== null) {
        sql += " AND p.round_ends_at_ms <= ?";
        values.push(throughEndMs);
      }
      sql += ` AND NOT EXISTS (
          SELECT 1 FROM waterx_settlement_evidence AS e
           WHERE e.interval_minutes = p.interval_minutes AND e.expected_round_id = p.round_id
             AND e.probe_bucket_ms = ?)
         AND NOT EXISTS (
          SELECT 1 FROM waterx_settlement_evidence AS e
           WHERE e.interval_minutes = p.interval_minutes AND e.expected_round_id = p.round_id
             AND e.verdict = 'VERIFIED')
         ORDER BY p.round_ends_at_ms ASC LIMIT 1`;
      values.push(probeBucketMs);
       const result = await this.env.DB.prepare(sql).bind(...values).all<{
         roundId: string; endsAtMs: number; marketId: string;
      }>();
      this.accountD1(state, result);
      return result.results[0];
    };
    return await query(cursor, null) ?? (cursor > 0 ? query(0, cursor) : undefined);
  }

  private async readHistorical(interval: WaterxInterval, closingEpoch: number) {
    const url = new URL(
      `https://api.waterx.app/predict/markets/crypto/crypto-btc-updown-${interval}m`,
    );
    url.searchParams.set("locale", "en");
    url.searchParams.set("epoch", String(closingEpoch));
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`WaterX historical HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1_000_000) throw new Error("WaterX historical response exceeded 1MB");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 1_000_000)
      throw new Error("WaterX historical response exceeded 1MB");
    return parseWaterxResponse(JSON.parse(text), interval);
  }

  private async writeSettlementEvidence(state: CollectorState, evidence: {
    interval: WaterxInterval; expectedRoundId: string; probeBucketMs: number; observedAtMs: number;
    expectedEnd: number; providerRoundId: string | null; providerEnd: number | null;
    status: string | null; outcome: string | null; settledAt: number | null; settlePrice: number | null;
    anchorPrice: number | null; anchorConfirmed: boolean;
    verdict: "VERIFIED" | "WITHHELD" | "IDENTITY_MISMATCH" | "READ_ERROR"; reason: string | null;
  }): Promise<void> {
    await this.run(state,
      `INSERT OR IGNORE INTO waterx_settlement_evidence
       (interval_minutes, expected_round_id, probe_bucket_ms, observed_at_ms,
        expected_closing_epoch, provider_round_id, provider_closing_epoch, provider_status,
         provider_outcome, provider_settled_at_epoch, provider_settle_price, provider_anchor_price,
        provider_anchor_confirmed, verdict, reason, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WaterX')`,
      evidence.interval, evidence.expectedRoundId, evidence.probeBucketMs, evidence.observedAtMs,
      evidence.expectedEnd, evidence.providerRoundId, evidence.providerEnd, evidence.status,
       evidence.outcome, evidence.settledAt, evidence.settlePrice, evidence.anchorPrice,
       Number(evidence.anchorConfirmed),
      evidence.verdict, evidence.reason,
    );
  }

  private async pruneOldSnapshots(state: CollectorState, nowMs: number): Promise<void> {
    await this.run(state, "DELETE FROM waterx_snapshots WHERE observed_at_ms < ?",
      nowMs - RETENTION_MS);
    await this.run(state, "DELETE FROM waterx_edge_coverage WHERE expected_round_start_ms < ?",
      nowMs - RETENTION_MS);
    await this.run(state, "DELETE FROM waterx_settlement_pending WHERE round_ends_at_ms < ?",
      nowMs - SETTLEMENT_LOOKBACK_MS);
  }

  private async finalizeCoverage(
    interval: WaterxInterval,
    state: CollectorState,
    nowMs: number,
  ): Promise<void> {
    const latest = state.latest[interval];
    state.coverageFlushedRounds ??= {};
    if (latest && latest.endsAtMs <= nowMs &&
        state.coverageFlushedRounds[interval] !== latest.roundId) {
      await this.persistSnapshot(
        latest, state,
        state.health[interval]?.maxFreshnessAgeMs ?? 0,
        state.health[interval]?.maxScheduledDelayMs ?? 0,
        state.roundHadGap?.[interval]?.roundId === latest.roundId &&
          state.roundHadGap[interval]!.hadGap,
        true,
      );
      state.coverageFlushedRounds[interval] = latest.roundId;
    }
    const thresholdMs = interval === 5 ? 15_000 : 30_000;
    await this.run(state,
      `UPDATE waterx_edge_coverage
          SET had_gap = 1
        WHERE interval_minutes = ?
          AND expected_round_start_ms >= ?
          AND expected_round_start_ms + ? <= ?
          AND had_gap = 0
           AND (first_success_at_ms IS NULL
                OR first_success_at_ms > expected_round_start_ms + ?
                OR last_success_at_ms < expected_round_start_ms + ? - ?)`,
      interval, nowMs - 24 * 60 * 60_000, interval * 60_000, nowMs,
      thresholdMs, interval * 60_000, thresholdMs,
    );
  }

  private trialStatus(state: CollectorState, nowMs: number): "NOT_STARTED" | "RUNNING" | "STOPPED" {
    if (state.trialStoppedAtMs != null ||
        (state.startedAtMs !== null && nowMs >= state.startedAtMs + TRIAL_WINDOW_MS))
      return "STOPPED";
    return state.startedAtMs === null ? "NOT_STARTED" : "RUNNING";
  }

  private async finalizeTerminalPartialCoverage(
    interval: WaterxInterval,
    state: CollectorState,
    cutoffMs: number,
  ): Promise<void> {
    const durationMs = interval * 60_000;
    const partialStartMs = Math.floor(cutoffMs / durationMs) * durationMs;
    if (partialStartMs >= cutoffMs) return;
    const thresholdMs = interval === 5 ? 15_000 : 30_000;
    await this.run(state,
      `UPDATE waterx_edge_coverage
          SET had_gap = 1
        WHERE interval_minutes = ?
          AND expected_round_start_ms = ?
          AND expected_round_start_ms + ? > ?
          AND had_gap = 0
          AND (first_success_at_ms IS NULL
               OR first_success_at_ms > expected_round_start_ms + ?
               OR last_success_at_ms IS NULL
               OR last_success_at_ms < ? - ?)`,
      interval, partialStartMs, durationMs, cutoffMs,
      thresholdMs, cutoffMs, thresholdMs,
    );
  }

  private async stopTrial(state: CollectorState, stoppedAtMs: number): Promise<void> {
    if (state.trialStoppedAtMs != null) {
      state.nextScheduledAt = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const trialCutoffMs = state.startedAtMs === null
      ? stoppedAtMs : state.startedAtMs + TRIAL_WINDOW_MS;
    // Account for the bounded expected window through the fixed trial cutoff,
    // even if the first alarm after an outage arrives well after expiry.
    for (const interval of intervals) {
      try {
        const durationMs = interval * 60_000;
        const expectedStartMs = Math.floor(trialCutoffMs / durationMs) * durationMs;
        await this.recordExpectedRounds(interval, state, expectedStartMs);
      } catch (error) {
        this.saveDatabaseError(interval, state, error);
      }
      // Capture the last actually observed quote, including an incomplete
      // current round, before persisting the terminal trial state.
      const latest = state.latest[interval];
      if (latest) {
        try {
          await this.persistSnapshot(
            latest, state,
            state.health[interval]?.maxFreshnessAgeMs ?? 0,
            state.health[interval]?.maxScheduledDelayMs ?? 0,
            state.roundHadGap?.[interval]?.roundId === latest.roundId &&
              state.roundHadGap[interval]!.hadGap,
            true,
          );
          if (latest.endsAtMs <= trialCutoffMs) {
            state.coverageFlushedRounds ??= {};
            state.coverageFlushedRounds[interval] = latest.roundId;
          }
        } catch (error) {
          this.saveDatabaseError(interval, state, error);
        }
      }
      try {
        await this.finalizeCoverage(interval, state, trialCutoffMs);
      } catch (error) {
        this.saveDatabaseError(interval, state, error);
      }
      try {
        await this.finalizeTerminalPartialCoverage(interval, state, trialCutoffMs);
      } catch (error) {
        this.saveDatabaseError(interval, state, error);
      }
    }
    state.trialStoppedAtMs = trialCutoffMs;
    state.nextScheduledAt = null;
    await this.saveState(state);
    await this.ctx.storage.deleteAlarm();
  }

  private saveDatabaseError(interval: WaterxInterval, state: CollectorState, error: unknown): void {
    const health = state.health[interval];
    state.health[interval] = health ? {
      ...health, d1Error: errorMessage(error),
    } : {
      intervalMinutes: interval, status: "WAITING", roundId: null, observedAt: null,
      lastAttemptAt: null, scheduledAt: null, freshnessAgeMs: null, scheduledDelayMs: null,
      maxFreshnessAgeMs: 0, maxScheduledDelayMs: 0,
      lastError: null, d1Error: errorMessage(error), settlementError: null,
      retries: 0, nextRetryAt: null,
    };
  }

  private async run(state: CollectorState, sql: string, ...values: unknown[]): Promise<void> {
    const result = await this.env.DB.prepare(sql).bind(...values).run();
    this.accountD1(state, result);
  }

  private accountD1(state: CollectorState, result: { meta?: SqlResult["meta"] }): void {
    state.d1Usage.rowsRead += result.meta?.rows_read ?? 0;
    state.d1Usage.rowsWritten += result.meta?.rows_written ?? result.meta?.changes ?? 0;
  }

  private async loadState(): Promise<CollectorState> {
    const state = await this.ctx.storage.get<CollectorState>(STATE_KEY);
    if (!state) return emptyState();
    // The trial/gap tracking fields were added after the original prototype
    // state shape was deployed. Default them in memory without a migration
    // write so legacy durable objects continue to load unchanged.
    state.startedAtMs ??= null;
    state.roundHadGap ??= {};
    state.coverageFlushedRounds ??= {};
    state.trialStoppedAtMs ??= null;
    return state;
  }

  private async saveState(state: CollectorState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const id = env.WATERX_COLLECTOR.idFromName("waterx-production-source-only");
    const requestedPath = new URL(request.url).pathname;
    const path = requestedPath === "/health" || requestedPath === "/coverage"
      ? requestedPath : "/latest";
    return env.WATERX_COLLECTOR.get(id).fetch(new Request(
      `https://waterx-do.invalid${path}`, { method: "GET" },
    ));
  },

  async scheduled(_controller: unknown, env: Environment): Promise<void> {
    // Cloudflare Cron runs without a browser/request. It seeds a missing alarm
    // and provides a one-minute watchdog if an alarm disappears.
    const id = env.WATERX_COLLECTOR.idFromName("waterx-production-source-only");
    await env.WATERX_COLLECTOR.get(id).fetch(new Request(
      "https://waterx-do.invalid/bootstrap", { method: "POST" },
    ));
  },
};