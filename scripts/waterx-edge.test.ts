import assert from "node:assert/strict";
import test from "node:test";
import EdgeWorker, { WaterxCollector } from "../edge/worker";

type Row = Record<string, unknown>;

class MemoryStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  alarms: number[] = [];
  deleteAlarmCalls = 0;
  getCalls = 0;
  putCalls = 0;

  async get<T>(key: string): Promise<T | undefined> {
    this.getCalls += 1;
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.putCalls += 1;
    this.values.set(key, structuredClone(value));
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarm = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    this.alarms.push(this.alarm);
  }
  async deleteAlarm(): Promise<void> {
    this.deleteAlarmCalls += 1;
    this.alarm = null;
  }
}

class MemoryD1 {
  failReads = false;
  failWrites = false;
  queries: Array<{ sql: string; values: unknown[] }> = [];
  rounds = new Map<string, Row>();
  snapshots = new Map<string, Row>();
  evidence = new Map<string, Row>();
  coverage = new Map<string, Row>();
  pending = new Map<string, Row>();

  prepare(sql: string) {
    const query = { sql, values: [] as unknown[] };
    this.queries.push(query);
    const statement = {
      bind: (...values: unknown[]) => {
        query.values = values;
        return statement;
      },
      all: async <T>() => {
        if (this.failReads) throw new Error("mock D1 read unavailable");
        if (sql.includes("FROM waterx_round_first AS r")) {
          const [interval, now, lookback, bucket] = query.values as number[];
          const result = [...this.rounds.values()].filter(row =>
            row.interval_minutes === interval &&
            (row.round_ends_at_ms as number) <= now &&
            (row.round_ends_at_ms as number) >= lookback &&
            ![...this.evidence.values()].some(evidence =>
              evidence.interval_minutes === interval &&
              evidence.expected_round_id === row.round_id &&
              evidence.verdict === "VERIFIED") &&
            !this.evidence.has(`${interval}:${row.round_id}:${bucket}`))
            .sort((a, b) => (a.round_ends_at_ms as number) - (b.round_ends_at_ms as number))
            .map(row => ({ roundId: row.round_id, endsAtMs: row.round_ends_at_ms }));
          return { results: result as T[] };
        }
        if (sql.includes("FROM waterx_settlement_pending")) {
          const [interval, now, lookback, after] = query.values as number[];
          const hasThroughBound = (sql.match(/p\.round_ends_at_ms <= \?/g) ?? []).length > 1;
          const through = hasThroughBound ? query.values[4] as number : null;
          const bucket = query.values[query.values.length - 1] as number;
          const result = [...this.pending.values()]
            .filter(row => row.interval_minutes === interval &&
              (row.round_ends_at_ms as number) <= now &&
              (row.round_ends_at_ms as number) >= lookback &&
              (row.round_ends_at_ms as number) > after &&
              (through === null || (row.round_ends_at_ms as number) <= through) &&
              !this.evidence.has(`${interval}:${row.round_id}:${bucket}`) &&
              ![...this.evidence.values()].some(e => e.interval_minutes === interval &&
                e.expected_round_id === row.round_id && e.verdict === "VERIFIED"))
            .sort((a, b) => (a.round_ends_at_ms as number) - (b.round_ends_at_ms as number))
            .slice(0, 1)
             .map(row => ({ roundId: row.round_id, endsAtMs: row.round_ends_at_ms,
               marketId: this.rounds.get(`${interval}:${row.round_id}`)?.market_id }));
          return { results: result as T[], meta: { rows_read: result.length } };
        }
        if (sql.includes("FROM waterx_edge_coverage")) {
          const [from, to] = query.values as number[];
          const rows = [...this.coverage.values()].filter(row =>
            (row.expected_round_start_ms as number) >= from &&
            (row.expected_round_start_ms as number) <= to);
          const result = [5, 15].flatMap(interval => {
            const selected = rows.filter(row => row.interval_minutes === interval);
            return selected.length ? [{
              intervalMinutes: interval, expectedRounds: selected.length,
              successfulRounds: selected.filter(row => row.first_success_at_ms != null).length,
              gapRounds: selected.reduce((sum, row) => sum + Number(row.had_gap), 0),
              maxFreshnessAgeMs: Math.max(0, ...selected.map(row =>
                Number(row.max_freshness_age_ms ?? 0))),
              maxScheduledDelayMs: Math.max(0, ...selected.map(row =>
                Number(row.max_scheduled_delay_ms ?? 0))),
            }] : [];
          });
          return { results: result as T[], meta: { rows_read: rows.length } };
        }
        if (sql.includes("FROM waterx_snapshots")) {
          const [from, to] = query.values as number[];
          const rows = [...this.snapshots.values()].filter(row =>
            (row.observed_at_ms as number) >= from && (row.observed_at_ms as number) <= to);
          const result = [5, 15].flatMap(interval => {
            const selected = rows.filter(row => row.interval_minutes === interval);
            if (!selected.length) return [];
            const missing = (field: string) => selected.filter(row => row[field] == null).length;
            return [{
              intervalMinutes: interval, sampleCount: selected.length,
              upProbabilityMissing: missing("up_probability_cents"),
              downProbabilityMissing: missing("down_probability_cents"),
              upOddsMissing: missing("up_odds_cents"), downOddsMissing: missing("down_odds_cents"),
              referenceMissing: missing("reference_price"),
              referenceUnconfirmed: selected.filter(row => row.reference_confirmed === 0).length,
            }];
          });
          return { results: result as T[], meta: { rows_read: rows.length } };
        }
        if (sql.includes("FROM waterx_settlement_evidence")) {
          const [from, to] = query.values as number[];
          const rows = [...this.evidence.values()].filter(row =>
            (row.observed_at_ms as number) >= from && (row.observed_at_ms as number) <= to);
          const result = [5, 15].flatMap(interval => {
            const selected = rows.filter(row => row.interval_minutes === interval);
            return selected.length ? [{
              intervalMinutes: interval, attempts: selected.length,
              verified: selected.filter(row => row.verdict === "VERIFIED").length,
              withheld: selected.filter(row => row.verdict === "WITHHELD").length,
              identityMismatch: selected.filter(row => row.verdict === "IDENTITY_MISMATCH").length,
              readErrors: selected.filter(row => row.verdict === "READ_ERROR").length,
            }] : [];
          });
          return { results: result as T[], meta: { rows_read: rows.length } };
        }
        return { results: [] as T[], meta: { rows_read: 0 } };
      },
      run: async () => {
        if (this.failWrites) throw new Error("mock D1 write unavailable");
        if (sql.includes("WITH RECURSIVE expected")) {
          const [start, duration, , end, count, interval] = query.values as number[];
          for (let i = 0; i < count; i += 1) {
            const expected = start + duration * i;
            const key = `${interval}:${expected}`;
            if (!this.coverage.has(key)) this.coverage.set(key, {
              interval_minutes: interval, expected_round_start_ms: expected,
              had_gap: Number(expected < end),
            });
          }
        } else if (sql.includes("INSERT OR IGNORE INTO waterx_round_first")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}`;
          if (!this.rounds.has(key)) this.rounds.set(key, {
            interval_minutes: v[0], round_id: v[1], market_id: v[2],
            round_starts_at_ms: v[3], round_ends_at_ms: v[4],
            first_observed_at_ms: v[5], up_probability_cents: v[6],
            down_probability_cents: v[7], up_odds_cents: v[8],
            down_odds_cents: v[9], reference_price: v[10],
            reference_confirmed: v[11], quote_source: "WaterX",
          });
        } else if (sql.includes("INSERT OR IGNORE INTO waterx_snapshots")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}:${v[2]}`;
          if (!this.snapshots.has(key)) this.snapshots.set(key, {
            interval_minutes: v[0], round_id: v[1], observed_bucket_ms: v[2],
            observed_at_ms: v[3], scheduled_at_ms: v[4],
            up_probability_cents: v[5], down_probability_cents: v[6],
            up_odds_cents: v[7], down_odds_cents: v[8],
            reference_price: v[9], reference_confirmed: v[10], source: "WaterX",
          });
        } else if (sql.includes("INSERT OR IGNORE INTO waterx_settlement_pending")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}`;
          if (!this.pending.has(key)) this.pending.set(key, {
            interval_minutes: v[0], round_id: v[1], round_ends_at_ms: v[2],
          });
        } else if (sql.includes("INSERT OR IGNORE INTO waterx_edge_coverage")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}`;
          if (!this.coverage.has(key)) this.coverage.set(key, {
            interval_minutes: v[0], expected_round_start_ms: v[1], had_gap: 0,
          });
        } else if (sql.includes("INSERT INTO waterx_edge_coverage")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}`;
          const previous = this.coverage.get(key) ?? {
            interval_minutes: v[0], expected_round_start_ms: v[1], had_gap: 0,
          };
          this.coverage.set(key, {
            ...previous,
            expected_round_id: v[2],
            first_success_at_ms: previous.first_success_at_ms ?? v[3],
            last_success_at_ms: v[4],
            max_freshness_age_ms: Math.max(
              (previous.max_freshness_age_ms as number | undefined) ?? 0,
              v[5] as number,
            ),
            max_scheduled_delay_ms: Math.max(
              (previous.max_scheduled_delay_ms as number | undefined) ?? 0,
              v[6] as number,
            ),
            had_gap: Math.max(previous.had_gap as number, v[7] as number),
          });
          (this.coverage.get(key) as Row).last_success_at_ms = v[4];
        } else if (sql.includes("INSERT OR IGNORE INTO waterx_settlement_evidence")) {
          const v = query.values;
          const key = `${v[0]}:${v[1]}:${v[2]}`;
          if (!this.evidence.has(key)) this.evidence.set(key, {
            interval_minutes: v[0], expected_round_id: v[1], probe_bucket_ms: v[2],
            observed_at_ms: v[3], expected_closing_epoch: v[4],
            provider_round_id: v[5], provider_closing_epoch: v[6],
             provider_status: v[7], provider_outcome: v[8], provider_settled_at_epoch: v[9],
             provider_settle_price: v[10], provider_anchor_price: v[11],
             provider_anchor_confirmed: v[12],
             verdict: v[13], reason: v[14], source: "WaterX",
          });
        } else if (sql.includes("DELETE FROM waterx_settlement_pending")) {
          this.pending.delete(`${query.values[0]}:${query.values[1]}`);
        } else if (sql.includes("DELETE FROM waterx_snapshots")) {
          const before = query.values[0] as number;
          for (const [key, row] of this.snapshots)
            if ((row.observed_at_ms as number) < before) this.snapshots.delete(key);
        } else if (sql.includes("UPDATE waterx_edge_coverage")) {
          assert.equal(query.values.length, 7, "coverage finalizer SQL and bindings remain aligned");
          if (sql.includes("expected_round_start_ms = ?")) {
            const [interval, partialStart, duration, cutoff, firstThreshold,
              tailCutoff, tailThreshold] = query.values as number[];
            for (const row of this.coverage.values()) {
              const start = row.expected_round_start_ms as number;
              if (row.interval_minutes === interval && start === partialStart &&
                  start + duration > cutoff && row.had_gap === 0 &&
                  (row.first_success_at_ms == null ||
                    (row.first_success_at_ms as number) > start + firstThreshold ||
                    row.last_success_at_ms == null ||
                    (row.last_success_at_ms as number) < tailCutoff - tailThreshold))
                row.had_gap = 1;
            }
          } else {
            const [interval, lowerBound, duration, cutoff, firstThreshold,
              tailDuration, tailThreshold] = query.values as number[];
            for (const row of this.coverage.values()) {
              const start = row.expected_round_start_ms as number;
              if (row.interval_minutes === interval && start >= lowerBound && row.had_gap === 0 &&
                  start + duration <= cutoff &&
                  (row.first_success_at_ms == null ||
                    (row.first_success_at_ms as number) > start + firstThreshold ||
                    (row.last_success_at_ms as number) < start + tailDuration - tailThreshold))
                row.had_gap = 1;
            }
          }
        }
        return { meta: { rows_written: 1 } };
      },
    };
    return statement;
  }
}

function runtime() {
  const storage = new MemoryStorage();
  const db = new MemoryD1();
  const collector = new WaterxCollector(
    { storage } as never,
    { DB: db } as never,
  );
  return { storage, db, collector };
}

function savedState(storage: MemoryStorage): Record<string, any> {
  return storage.values.get("collectorState") as Record<string, any>;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function response(interval: 5 | 15, startsAt: number, options: {
  id?: string;
  anchor?: number | null;
  confirmed?: boolean;
  upProbability?: number | null;
  downProbability?: number | null;
  upOdds?: number | null;
  downOdds?: number | null;
  phase?: string;
  outcome?: string | null;
  settlement?: { outcome: string | null; settledAt: number | null } | null;
  settlePrice?: number | null;
  resolutionStatus?: string | null;
} = {}): Record<string, unknown> {
  const endsAt = startsAt + interval * 60;
  return {
    success: true,
    data: { detail: {
      market: { slug: `crypto-btc-updown-${interval}m`, marketId: `btc-${interval}m` },
      round: {
        id: options.id ?? uuid(interval * 1000 + startsAt),
        marketId: `btc-${interval}m`, startsAt, endsAt,
        phase: options.phase ?? "ACTIVE",
        anchorPrice: Object.hasOwn(options, "anchor") ? options.anchor : 68_123.45,
        anchorPriceConfirmed: options.confirmed ?? true,
        sides: [
          { key: "up", oddsCents: Object.hasOwn(options, "upOdds") ? options.upOdds : 51,
            probabilityCents: Object.hasOwn(options, "upProbability") ? options.upProbability : 52 },
          { key: "down", oddsCents: Object.hasOwn(options, "downOdds") ? options.downOdds : 49,
            probabilityCents: Object.hasOwn(options, "downProbability") ? options.downProbability : 48 },
        ],
        settlement: options.settlement ?? (options.outcome ? {
          outcome: options.outcome, settledAt: endsAt + 3,
        } : null),
        settlePrice: options.settlePrice ?? null,
        resolutionStatus: options.resolutionStatus ?? null,
      },
      neighbors: { past: [], upcoming: [] },
    } },
  };
}

function providerFetch(
  now: () => number,
  overrides: (url: URL, interval: 5 | 15, start: number) => Record<string, unknown> | Error =
    (_url, interval, start) => response(interval, start),
) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    const duration = interval * 60_000;
    const start = Math.floor(now() / duration) * (duration / 1000);
    const payload = overrides(url, interval, start);
    if (payload instanceof Error) throw payload;
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
}

async function runAlarm(
  collector: WaterxCollector,
  _storage: MemoryStorage,
  _scheduledAt: number,
): Promise<void> {
  _storage.alarm = null;
  await collector.alarm();
}

async function getJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("one-minute cron bootstraps a persisted alarm without any browser request", async () => {
  const { storage, collector } = runtime();
  let workerRequests = 0;
  const namespace = {
    idFromName(name: string) { assert.equal(name, "waterx-production-source-only"); return name; },
    get() {
      return { async fetch(request: Request) {
        workerRequests += 1;
        return collector.fetch(request);
      } };
    },
  };
  const now = Date.now;
  const fixed = 1_800_000_000_000;
  Date.now = () => fixed;
  try {
    await EdgeWorker.scheduled?.({}, { WATERX_COLLECTOR: namespace } as never);
    assert.equal(workerRequests, 1);
    assert.equal(storage.alarm, fixed);
    assert.equal(storage.putCalls, 1, "only the aggregate state row is written by bootstrap");
    assert.equal(storage.values.size, 1);
    assert.equal(await storage.get("latest:5"), undefined);
    assert.equal(await storage.get("latest:15"), undefined);
    const status = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    assert.equal(status.browserRequired, false);
    assert.equal((status.latest as unknown[] | undefined), undefined);
  } finally {
    Date.now = now;
  }
});

test("alarms poll 5m every tick and 15m on alternating ticks, persisting first identity and 30s snapshots", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_060_000_000;
  let calls5 = 0;
  let calls15 = 0;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (url, interval, start) => {
    if (interval === 5) calls5 += 1;
    else calls15 += 1;
    return response(interval, start, { id: uuid(interval === 5 ? 501 : 1501) });
  });
  try {
    await runAlarm(collector, storage, now);
    assert.equal(calls5, 1);
    assert.equal(calls15, 1);
    const first = await getJson(await collector.fetch(new Request("https://edge.test/latest")));
    const latest5 = (first.latest as Array<Record<string, unknown>>)
      .find(round => round.intervalMinutes === 5)!;
    assert.equal(latest5.roundId, uuid(501));
    assert.equal(latest5.source, "WaterX");
    assert.equal(db.rounds.size, 2);
    assert.equal(db.snapshots.size, 2);

    now += 5_000;
    await runAlarm(collector, storage, now);
    assert.equal(calls5, 2);
    assert.equal(calls15, 1);
    assert.equal(db.rounds.size, 2);
    assert.equal(db.snapshots.size, 2, "same 30s bucket is idempotent");

    now += 30_000;
    await runAlarm(collector, storage, now);
    assert.equal(calls5, 3);
    assert.equal(calls15, 2);
    assert.equal(db.rounds.get(`5:${uuid(501)}`)?.up_probability_cents, 52,
      "the immutable first-round observation is not overwritten");
    assert.equal(db.snapshots.size, 4);
    const status = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    const health5 = (status.health as Array<Record<string, unknown>>)
      .find(item => item.intervalMinutes === 5)!;
    assert.equal(health5.status, "LIVE");
    assert.equal(health5.roundId, uuid(501));
    assert.equal(health5.freshnessAgeMs, 0);
    assert.equal(health5.scheduledDelayMs, 25_000);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("each alarm uses one aggregate state row read/write, with conservative daily bounds including cron", async () => {
  const { storage, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_090_000_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    storage.getCalls = 0;
    storage.putCalls = 0;
    await runAlarm(collector, storage, now);
    assert.equal(storage.getCalls, 1);
    assert.equal(storage.putCalls, 1);
    assert.equal(storage.values.size, 1, "all mutable DO state is one aggregate record");
    assert.equal(storage.alarms.length, 1);

    const upperBound = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    assert.deepEqual(upperBound.durableObjectStorageWriteUpperBound24h, {
      alarmInvocations: 17_280,
      cronInvocations: 1_440,
      aggregateStateRowsWritten: 18_720,
      setAlarmWrites: 18_720,
      includingSetAlarmWrites: 37_440,
      basis: "nominal schedule, with every cron assumed to find the alarm missing",
      excludesAtLeastOnceRedeliveries: true,
    });
    assert.ok(37_440 < 100_000, "conservative DO state+alarm writes remain below the daily row cap");
    storage.getCalls = 0;
    storage.putCalls = 0;
    const scheduledAlarmCount = storage.alarms.length;
    const namespace = {
      idFromName: () => "collector",
      get: () => ({ fetch: (request: Request) => collector.fetch(request) }),
    };
    await EdgeWorker.scheduled?.({}, { WATERX_COLLECTOR: namespace } as never);
    assert.equal(storage.getCalls, 1);
    assert.equal(storage.putCalls, 0, "steady-state cron watchdog does not rewrite aggregate state");
    assert.equal(storage.alarms.length, scheduledAlarmCount, "cron only resets a missing alarm");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("rollover stores a new round identity instead of relabeling the old round", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_120_000_000;
  const firstStart = Math.floor(now / 300_000) * 300;
  const oldId = uuid(6001);
  const newId = uuid(6002);
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, start) =>
    response(interval, start, { id: interval === 5 ? (start === firstStart ? oldId : newId) : uuid(1600) }));
  try {
    await runAlarm(collector, storage, now);
    now = firstStart * 1_000 + 300_000;
    await runAlarm(collector, storage, now);
    assert.ok(db.rounds.has(`5:${oldId}`));
    assert.ok(db.rounds.has(`5:${newId}`));
    const latest = await getJson(await collector.fetch(new Request("https://edge.test/latest")));
    assert.equal((latest.latest as Array<Record<string, unknown>>)
      .find(row => row.intervalMinutes === 5)?.roundId, newId);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("odds and WaterX reference remain separate when either is unavailable", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_180_000_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (url, interval, start) =>
    interval === 5
      ? response(interval, start, {
        id: uuid(7001), upProbability: null, upOdds: null,
        anchor: null, confirmed: false,
      })
      : response(interval, start, { id: uuid(1700), confirmed: false }));
  try {
    await runAlarm(collector, storage, now);
    const status = await getJson(await collector.fetch(new Request("https://edge.test/latest")));
    const latest = status.latest as Array<Record<string, unknown>>;
    const five = latest.find(row => row.intervalMinutes === 5)!;
    assert.equal(five.roundId, uuid(7001));
    assert.equal(five.upProbabilityCents, null);
    assert.equal(five.downProbabilityCents, 48);
    assert.equal(five.referencePrice, null);
    assert.equal(five.referenceConfirmed, false);
    assert.equal(db.rounds.get(`5:${uuid(7001)}`)?.quote_source, "WaterX");
    const coverage = await getJson(await collector.fetch(new Request("https://edge.test/coverage")));
    assert.equal(coverage.complete, false, "a partial window cannot be labeled a complete 24h");
    const fiveMinute = (coverage.intervals as Array<Record<string, any>>)
      .find(row => row.intervalMinutes === 5)!;
    assert.equal(fiveMinute.samples.upProbabilityMissing, 1);
    assert.equal(fiveMinute.samples.upOddsMissing, 1);
    assert.equal(fiveMinute.samples.referenceMissing, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("alarm outage backfills bounded expected-round gap rows without inventing provider observations", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_210_000_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    await runAlarm(collector, storage, now);
    const firstSnapshots = db.snapshots.size;
    now += 25 * 60 * 60_000;
    await runAlarm(collector, storage, now);
    await runAlarm(collector, storage, now + 5_000);
    assert.ok(db.coverage.size >= 96, "missed 5m and 15m expected boundaries are recorded");
    const expected5 = Math.floor(now / 300_000) * 300_000;
    const expected15 = Math.floor(now / 900_000) * 900_000;
    assert.ok([...db.coverage.values()].filter(row => row.interval_minutes === 5 &&
      (row.expected_round_start_ms as number) >= now - 24 * 60 * 60_000 &&
      (row.expected_round_start_ms as number) < expected5).every(row => row.had_gap === 1));
    assert.ok([...db.coverage.values()].filter(row => row.interval_minutes === 15 &&
      (row.expected_round_start_ms as number) >= now - 24 * 60 * 60_000 &&
      (row.expected_round_start_ms as number) < expected15).every(row => row.had_gap === 1));
    assert.ok([...db.coverage.values()].filter(row => row.interval_minutes === 5).length <= 290);
    assert.ok([...db.coverage.values()].filter(row => row.interval_minutes === 15).length <= 98);
    assert.ok(db.snapshots.size <= firstSnapshots + 4,
      "only actually fetched current rounds produce snapshots");
    assert.ok(db.evidence.size > 0, "settlement lookback includes rounds expired over 30 minutes ago");
    assert.equal(savedState(storage).coverageRound[5], Math.floor(now / 300_000) * 300_000);
    assert.equal(savedState(storage).coverageRound[15], Math.floor(now / 900_000) * 900_000);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("24h endpoint waits for the elapsed window, then reports accounted gaps and field-level coverage", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_270_000_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    await runAlarm(collector, storage, now);
    const before = await getJson(await collector.fetch(new Request("https://edge.test/coverage")));
    assert.equal(before.complete, false);
    const queryCount = db.queries.length;
    await collector.fetch(new Request("https://edge.test/coverage"));
    assert.equal(db.queries.length, queryCount, "five-minute memory cache avoids repeated D1 scans");
    now += 24 * 60 * 60_000;
    await runAlarm(collector, storage, now);
    await runAlarm(collector, storage, now + 5_000);
    storage.putCalls = 0;
    const result = await getJson(await collector.fetch(new Request("https://edge.test/coverage")));
    assert.equal(storage.putCalls, 0, "coverage is a read-only metrics endpoint");
    assert.equal(result.full24hElapsed, true);
    assert.equal(result.complete, true);
    assert.ok(Number(result.d1RowsReadForCalculation) > 0);
    const summaries = result.intervals as Array<Record<string, any>>;
    assert.equal(summaries.find(row => row.intervalMinutes === 5)?.expectedRounds, 289);
    assert.equal(summaries.find(row => row.intervalMinutes === 15)?.expectedRounds, 97);
    assert.ok(summaries.every(row => row.gapRounds > 0 && row.gapFree === false));
    assert.ok(db.snapshots.size <= 4, "backfilled gaps never create fabricated snapshots");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("first observation four minutes into a round is a gap, not gap-free coverage", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const startMs = 1_800_200_000_000;
  const now = Math.floor(startMs / 300_000) * 300_000 + 4 * 60_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, start) =>
    response(interval, start, { id: uuid(interval === 5 ? 8901 : 1890) }));
  try {
    await runAlarm(collector, storage, now);
    const roundStart = Math.floor(now / 300_000) * 300_000;
    assert.equal(db.coverage.get(`5:${roundStart}`)?.had_gap, 1);
    assert.ok(db.snapshots.size > 0, "late provider evidence is still retained");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a timely first round does not mask late first observations in later rounds", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_510_000_000 / 300_000) * 300_000 + 5_000;
  const firstStart = Math.floor(now / 300_000) * 300_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, start) =>
    response(interval, start, { id: interval === 5
      ? (start * 1_000 === firstStart ? uuid(89_011) : uuid(89_012))
      : uuid(18_911) }));
  try {
    await runAlarm(collector, storage, now);
    now = firstStart + 300_000 + 20_000;
    await runAlarm(collector, storage, now);
    const laterRoundStart = firstStart + 300_000;
    assert.equal(db.coverage.get(`5:${laterRoundStart}`)?.had_gap, 1,
      "late first observation of a later round is immediately marked as a gap");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a healthy full round crossing its boundary remains gap-free and freezes first observation", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_540_000_000 / 300_000) * 300_000 + 5_000;
  const start = Math.floor(now / 300_000) * 300_000;
  const firstId = uuid(89_101);
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, roundStart) =>
    response(interval, roundStart, {
      id: interval === 5 ? (roundStart * 1_000 === start ? firstId : uuid(89_102)) : uuid(18_910),
    }));
  try {
    await runAlarm(collector, storage, now);
    const frozenFirstObservedAt = db.rounds.get(`5:${firstId}`)?.first_observed_at_ms;
    while (now < start + 300_000) {
      now = Math.min(now + 5_000, start + 300_000);
      await runAlarm(collector, storage, now);
    }
    const row = db.coverage.get(`5:${start}`)!;
    assert.equal(row.had_gap, 0, "normal timely samples do not inherit round age as a gap");
    assert.equal(row.last_success_at_ms, start + 295_000);
    assert.equal(db.rounds.get(`5:${firstId}`)?.first_observed_at_ms, frozenFirstObservedAt,
      "round first-observed metadata is immutable");
    assert.ok(db.rounds.has(`5:${uuid(89_102)}`), "the new round is persisted on rollover");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a non-live rollover flushes the prior round before tail finalization", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_555_000_000 / 300_000) * 300_000 + 5_000;
  const start = Math.floor(now / 300_000) * 300_000;
  const end = start + 300_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, roundStart) => {
    if (interval === 5 && now >= end) return new Error("temporary non-live boundary response");
    return response(interval, roundStart, { id: interval === 5 ? uuid(89_103) : uuid(18_913) });
  });
  try {
    while (now <= end - 5_000) {
      await runAlarm(collector, storage, now);
      now += 5_000;
    }
    await runAlarm(collector, storage, now);
    now = end + 16_000;
    await runAlarm(collector, storage, now);
    const prior = db.coverage.get(`5:${start}`)!;
    assert.equal(prior.last_success_at_ms, end - 5_000,
      "the true last observation is flushed despite no LIVE response after rollover");
    assert.equal(prior.had_gap, 0, "timely completed-round data is not tail-gapped");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a freshness gap spanning adjacent rounds marks both affected rounds", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_558_000_000 / 300_000) * 300_000 + 5_000;
  const start = Math.floor(now / 300_000) * 300_000;
  const boundary = start + 300_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, roundStart) =>
    response(interval, roundStart, { id: interval === 5
      ? (roundStart * 1_000 === start ? uuid(89_104) : uuid(89_105))
      : uuid(18_914) }));
  try {
    while (now < boundary - 10_000) {
      await runAlarm(collector, storage, now);
      now += 5_000;
    }
    await runAlarm(collector, storage, now);
    now = boundary + 10_000;
    await runAlarm(collector, storage, now);
    assert.equal(db.coverage.get(`5:${start}`)?.had_gap, 1,
      "the prior round records the true cross-boundary freshness gap");
    assert.equal(db.coverage.get(`5:${boundary}`)?.had_gap, 1,
      "the first observation of the new round records the same gap");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("trial stop marks a completed round even before the old tail-delay threshold", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_561_000_000 / 300_000) * 300_000 + 5_000;
  const start = Math.floor(now / 300_000) * 300_000;
  const end = start + 300_000;
  const cutoff = end + 10_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    while (now <= end - 25_000) {
      await runAlarm(collector, storage, now);
      now += 5_000;
    }
    await runAlarm(collector, storage, now);
    const state = savedState(storage);
    state.startedAtMs = cutoff - 26 * 60 * 60_000;
    await storage.put("collectorState", state);
    now = cutoff;
    await runAlarm(collector, storage, now);
    assert.equal(savedState(storage).trialStoppedAtMs, cutoff);
    assert.equal(db.coverage.get(`5:${start}`)?.last_success_at_ms, end - 20_000);
    assert.equal(db.coverage.get(`5:${start}`)?.had_gap, 1,
      "terminal finalization evaluates completed rounds immediately, without threshold delay");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("frozen trial coverage gaps a partial final round after an early outage", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_564_000_000 / 300_000) * 300_000 + 5_000;
  const partialStart = Math.floor(now / 300_000) * 300_000;
  const cutoff = partialStart + 240_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    await collector.fetch(new Request("https://edge.test/bootstrap", { method: "POST" }));
    await runAlarm(collector, storage, now);
    assert.equal(db.coverage.get(`5:${partialStart}`)?.had_gap, 0,
      "the timely initial partial-round observation is not an immediate gap");
    const state = savedState(storage);
    state.startedAtMs = cutoff - 26 * 60 * 60_000;
    await storage.put("collectorState", state);
    now = cutoff;
    await runAlarm(collector, storage, now);
    assert.equal(savedState(storage).trialStoppedAtMs, cutoff);
    assert.equal(db.coverage.get(`5:${partialStart}`)?.last_success_at_ms, partialStart + 5_000);
    assert.equal(db.coverage.get(`5:${partialStart}`)?.had_gap, 1,
      "the final partial round is judged against the terminal cutoff, not its nominal end");
    const summary = await getJson(await collector.fetch(
      new Request("https://edge.test/coverage"),
    ));
    const five = (summary.intervals as Array<Record<string, any>>)
      .find(row => row.intervalMinutes === 5)!;
    assert.ok(five.gapRounds > 0);
    assert.equal(five.gapFree, false,
      "the frozen final-window summary cannot claim gap-free coverage");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("bootstrap during an in-flight alarm does not write stale durable state", async () => {
  const { storage, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const now = 1_800_585_000_000;
  Date.now = () => now;
  let unblock!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  let calls = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    const roundStart = Math.floor(now / (interval * 60_000)) * interval * 60;
    calls += 1;
    if (calls === 2) signalStarted();
    await gate;
    return new Response(JSON.stringify(response(interval, roundStart)), { status: 200 });
  };
  try {
    await collector.fetch(new Request("https://edge.test/bootstrap", { method: "POST" }));
    const putsBeforeAlarm = storage.putCalls;
    const alarmsBeforeAlarm = storage.alarms.length;
    storage.alarm = null;
    const alarm = collector.alarm();
    await started;
    const bootstrap = await getJson(await collector.fetch(
      new Request("https://edge.test/bootstrap", { method: "POST" }),
    ));
    assert.equal(storage.putCalls, putsBeforeAlarm,
      "cron bootstrap does not persist a stale state while the alarm is polling");
    assert.equal(storage.alarms.length, alarmsBeforeAlarm,
      "cron bootstrap does not replace the alarm during provider work");
    assert.equal(bootstrap.trialStatus, "RUNNING");
    unblock();
    await alarm;
    assert.equal(storage.putCalls, putsBeforeAlarm + 1,
      "the in-flight alarm persists the authoritative state once");
  } finally {
    unblock();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("an intra-round freshness gap spanning D1 buckets remains cumulative", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Math.floor(1_800_570_000_000 / 300_000) * 300_000 + 5_000;
  const start = Math.floor(now / 300_000) * 300_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    await runAlarm(collector, storage, now);
    now = start + 10_000;
    await runAlarm(collector, storage, now);
    now = start + 35_000;
    await runAlarm(collector, storage, now);
    assert.equal(db.coverage.get(`5:${start}`)?.had_gap, 1,
      "the true 25s gap is retained when the next sample is in another bucket");
    assert.ok(db.snapshots.size <= 4, "no extra per-poll snapshots are created");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("coverage remains anchored to the durable trial stop time after collection ends", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_590_000_000;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now);
  try {
    await collector.fetch(new Request("https://edge.test/bootstrap", { method: "POST" }));
    await runAlarm(collector, storage, now);
    const startedAt = savedState(storage).startedAtMs;
    now = startedAt + 26 * 60 * 60_000;
    await runAlarm(collector, storage, now);
    const stoppedAt = savedState(storage).trialStoppedAtMs;
    const finalCoverage = await getJson(await collector.fetch(
      new Request("https://edge.test/coverage"),
    ));
    assert.equal(finalCoverage.windowEndMs, stoppedAt);
    assert.equal(finalCoverage.calculatedAtMs, now,
      "the calculation timestamp is distinct from the frozen data window end");
    const queryCount = db.queries.length;
    now += 3 * 60 * 60_000;
    const laterCoverage = await getJson(await collector.fetch(
      new Request("https://edge.test/coverage"),
    ));
    assert.equal(laterCoverage.windowEndMs, stoppedAt);
    assert.equal(laterCoverage.calculatedAtMs, now);
    assert.equal(db.queries.length, queryCount + 3,
      "later calculations rescan the same frozen final window, not a sliding window");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a late stop backfills only bounded expected rounds through the fixed trial cutoff", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_595_000_000;
  let providerCalls = 0;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, start) => {
    providerCalls += 1;
    return response(interval, start);
  });
  try {
    await collector.fetch(new Request("https://edge.test/bootstrap", { method: "POST" }));
    const startedAt = savedState(storage).startedAtMs;
    await runAlarm(collector, storage, now);
    const callsBeforeOutage = providerCalls;
    const cutoff = startedAt + 26 * 60 * 60_000;
    now = startedAt + 48 * 60 * 60_000;
    await runAlarm(collector, storage, now);
    assert.equal(providerCalls, callsBeforeOutage, "expired collection is not resumed for catch-up");
    assert.equal(savedState(storage).trialStoppedAtMs, cutoff);
    for (const interval of [5, 15] as const) {
      const durationMs = interval * 60_000;
      const cutoffStart = Math.floor(cutoff / durationMs) * durationMs;
      const rows = [...db.coverage.values()].filter(row => row.interval_minutes === interval);
      assert.ok(rows.some(row => row.expected_round_start_ms === cutoffStart),
        `${interval}m expected-round catch-up reaches the final trial boundary`);
      assert.ok(rows.every(row => row.expected_round_start_ms <= cutoffStart),
        "catch-up must not invent expected rounds beyond the fixed cutoff");
      assert.equal(savedState(storage).coverageRound[interval], cutoffStart);
      assert.ok(rows.length <= (interval === 5 ? 290 : 98),
        "late-stop catch-up remains capped");
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("26-hour trial stops durably and cron bootstrap cannot restart collection", async () => {
  const { storage, collector } = runtime();
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  let now = 1_800_600_000_000;
  let providerCalls = 0;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (_url, interval, start) => {
    providerCalls += 1;
    return response(interval, start);
  });
  const namespace = {
    idFromName: () => "collector",
    get: () => ({ fetch: (request: Request) => collector.fetch(request) }),
  };
  try {
    await collector.fetch(new Request("https://edge.test/bootstrap", { method: "POST" }));
    const startedAt = savedState(storage).startedAtMs;
    assert.equal(startedAt, now);
    await runAlarm(collector, storage, now);
    const callsBeforeStop = providerCalls;
    now = startedAt + 26 * 60 * 60_000;
    await runAlarm(collector, storage, now);
    assert.equal(providerCalls, callsBeforeStop, "expired alarm does not poll WaterX");
    assert.equal(storage.alarm, null);
    assert.equal(savedState(storage).nextScheduledAt, null);
    const stoppedAt = savedState(storage).trialStoppedAtMs;
    assert.equal(stoppedAt, now);
    const health = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    assert.equal(health.trialStatus, "STOPPED");
    assert.equal(health.stopsAtMs, startedAt + 26 * 60 * 60_000);
    const stopCalls = storage.putCalls;
    await EdgeWorker.scheduled?.({}, { WATERX_COLLECTOR: namespace } as never);
    assert.equal(storage.alarm, null, "cron does not seed a fresh alarm after stop");
    assert.equal(storage.putCalls, stopCalls, "the stopped status is persisted only once");
    assert.equal((await getJson(await collector.fetch(new Request("https://edge.test/bootstrap", {
      method: "POST",
    })))).trialStatus, "STOPPED");
    assert.equal(storage.alarm, null);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("transient source failure records bounded backoff and still schedules the next alarm", async () => {
  const { storage, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_240_000_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("WaterX temporarily unavailable");
  };
  try {
    await runAlarm(collector, storage, now);
    const health = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    const five = (health.health as Array<Record<string, unknown>>)
      .find(row => row.intervalMinutes === 5)!;
    assert.equal(five.status, "UNAVAILABLE");
    assert.equal(five.retries, 1);
    assert.equal(five.nextRetryAt, now + 5_000);
    assert.equal(storage.alarm, now + 5_000);
    now += 1_000;
    await runAlarm(collector, storage, now);
    assert.equal(calls, 2, "15m is skipped on the alternating tick; retry due time gates failed reads");
    assert.equal(storage.alarms.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("D1 write and settlement-read failures do not stop latest reads or future alarms", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_300_000_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = providerFetch(() => now, (url, interval, start) => {
    calls += 1;
    return response(interval, start, { id: uuid(interval === 5 ? 9001 : 1900) });
  });
  try {
    db.failWrites = true;
    await runAlarm(collector, storage, now);
    const health = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    const five = (health.health as Array<Record<string, unknown>>)
      .find(row => row.intervalMinutes === 5)!;
    assert.equal(five.status, "LIVE");
    assert.match(String(five.d1Error), /mock D1 write unavailable/);
    assert.equal(five.settlementError, null, "D1 write failures do not appear as provider errors");
    assert.equal((await getJson(await collector.fetch(new Request("https://edge.test/latest"))))
      .latest instanceof Array, true);
    assert.equal(storage.alarm, now + 5_000);

    db.failWrites = false;
    db.failReads = true;
    now += 65_000;
    await runAlarm(collector, storage, now);
    assert.equal(storage.alarm, now + 5_000);
    assert.ok(calls > 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("historical provider failures are recorded as READ_ERROR and never mislabeled as D1 errors", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_330_000_000;
  const start = Math.floor(now / 300_000) * 300;
  Date.now = () => now;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("epoch"))
      return new Response("provider unavailable", { status: 503 });
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    const roundStart = Math.floor(now / (interval * 60_000)) * interval * 60;
    return new Response(JSON.stringify(response(interval, roundStart, {
      id: interval === 5 ? uuid(9301) : uuid(1930),
    })), { status: 200 });
  };
  try {
    await runAlarm(collector, storage, now);
    now = start * 1_000 + 365_000;
    await runAlarm(collector, storage, now);
    const health = await getJson(await collector.fetch(new Request("https://edge.test/health")));
    const five = (health.health as Array<Record<string, unknown>>)
      .find(row => row.intervalMinutes === 5)!;
    assert.match(String(five.settlementError), /historical HTTP 503/);
    assert.equal(five.d1Error, null);
    assert.ok([...db.evidence.values()].some(row => row.verdict === "READ_ERROR" &&
      String(row.reason).includes("HTTP 503")));
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("settlement requires exact identity, closing epoch, provider outcome, price, and confirmed WaterX anchor", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_360_000_000;
  const start = Math.floor(now / 300_000) * 300;
  const expectedId = uuid(10_001);
  let historical = response(5, start, {
    id: expectedId,
    resolutionStatus: "RESOLVED",
    outcome: "DOWN",
    settlePrice: 68_000,
    confirmed: true,
  });
  Date.now = () => now;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("epoch")) return new Response(JSON.stringify(historical), { status: 200 });
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    const roundStart = Math.floor(now / (interval * 60_000)) * interval * 60;
    return new Response(JSON.stringify(response(interval, roundStart, {
      id: interval === 5 ? expectedId : uuid(2000),
    })), { status: 200 });
  };
  try {
    await runAlarm(collector, storage, now);
    now = start * 1_000 + 365_000;
    await runAlarm(collector, storage, now);
    const valid = [...db.evidence.values()].find(row => row.verdict === "VERIFIED");
    assert.ok(valid);
    assert.equal(valid.provider_outcome, "down");
    assert.equal(valid.provider_settle_price, 68_000);
    assert.equal(valid.provider_settled_at_epoch, start + 303);
    assert.equal(valid.provider_anchor_confirmed, 1);
    assert.equal(valid.source, "WaterX");

    const unresolved = response(5, start, {
      id: uuid(10_002), resolutionStatus: "RESOLVED",
      settlePrice: 68_000, confirmed: true,
    });
    db.rounds.set(`5:${uuid(10_002)}`, {
      interval_minutes: 5, round_id: uuid(10_002),
      market_id: "btc-5m",
      round_ends_at_ms: start * 1_000 + 300_000,
    });
    db.pending.set(`5:${uuid(10_002)}`, {
      interval_minutes: 5, round_id: uuid(10_002),
      round_ends_at_ms: start * 1_000 + 300_000,
    });
    historical = unresolved;
    now += 65_000;
    await runAlarm(collector, storage, now);
    assert.ok([...db.evidence.values()].some(row =>
      row.expected_round_id === uuid(10_002) && row.verdict === "WITHHELD" &&
      row.provider_outcome === null));

    historical = response(5, start, {
      id: uuid(10_002), resolutionStatus: "RESOLVED",
      outcome: "UP", settlePrice: 68_000, confirmed: true,
    });
    now += 65_000;
    await runAlarm(collector, storage, now);
    assert.ok([...db.evidence.values()].some(row =>
      row.expected_round_id === uuid(10_002) && row.verdict === "WITHHELD" &&
      String(row.reason).includes("contradicts")));

    historical = response(5, start, {
      id: uuid(10_002), resolutionStatus: "RESOLVED",
      settlement: { outcome: "DOWN", settledAt: null },
      settlePrice: 68_000, confirmed: true,
    });
    now += 65_000;
    await runAlarm(collector, storage, now);
    assert.ok([...db.evidence.values()].some(row =>
      row.expected_round_id === uuid(10_002) && row.verdict === "WITHHELD" &&
      String(row.reason).includes("post-expiry")));
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("historical evidence records round-ID and closing-epoch mismatches without guessing labels", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_420_000_000;
  const start = Math.floor(now / 300_000) * 300;
  const expectedId = uuid(11_001);
  const wrongId = uuid(11_002);
  let historical = response(5, start, {
    id: wrongId, resolutionStatus: "RESOLVED", outcome: "UP",
    settlePrice: 67_000, confirmed: true,
  });
  Date.now = () => now;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("epoch")) return new Response(JSON.stringify(historical), { status: 200 });
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    const roundStart = Math.floor(now / (interval * 60_000)) * interval * 60;
    return new Response(JSON.stringify(response(interval, roundStart, {
      id: interval === 5 ? expectedId : uuid(2100),
    })), { status: 200 });
  };
  try {
    await runAlarm(collector, storage, now);
    now = start * 1_000 + 365_000;
    await runAlarm(collector, storage, now);
    const wrongIdentity = [...db.evidence.values()].find(row =>
      row.expected_round_id === expectedId);
    assert.equal(wrongIdentity?.verdict, "IDENTITY_MISMATCH");
    assert.equal(wrongIdentity?.provider_round_id, wrongId);
    assert.equal(wrongIdentity?.expected_closing_epoch, start + 300);
    assert.equal(wrongIdentity?.provider_closing_epoch, start + 300);

    const secondExpected = uuid(11_003);
    db.rounds.set(`5:${secondExpected}`, {
      interval_minutes: 5, round_id: secondExpected,
      market_id: "btc-5m",
      round_ends_at_ms: start * 1_000 + 600_000,
    });
    db.pending.set(`5:${secondExpected}`, {
      interval_minutes: 5, round_id: secondExpected,
      round_ends_at_ms: start * 1_000 + 600_000,
    });
    historical = response(5, start + 600, {
      id: secondExpected, resolutionStatus: "RESOLVED", outcome: "DOWN",
      settlePrice: 67_000, confirmed: true,
    });
    now += 365_000;
    await runAlarm(collector, storage, now);
    const wrongEpoch = [...db.evidence.values()].find(row =>
      row.expected_round_id === secondExpected);
    assert.equal(wrongEpoch?.verdict, "IDENTITY_MISMATCH");
    assert.equal(wrongEpoch?.provider_round_id, secondExpected);
    assert.notEqual(wrongEpoch?.provider_closing_epoch, wrongEpoch?.expected_closing_epoch);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a historical round with the right UUID and closing time but a different frozen market is withheld", async () => {
  const { storage, db, collector } = runtime();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_500_000_000;
  const start = Math.floor(now / 300_000) * 300;
  const roundId = uuid(12_001);
  Date.now = () => now;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("epoch")) return new Response(JSON.stringify(response(5, start, {
      id: roundId, resolutionStatus: "RESOLVED", outcome: "DOWN",
      settlePrice: 68_000, confirmed: true,
    })));
    const interval = url.pathname.endsWith("-5m") ? 5 : 15;
    return new Response(JSON.stringify(response(interval,
      Math.floor(now / (interval * 60_000)) * interval * 60,
      { id: interval === 5 ? roundId : uuid(2500) })));
  };
  try {
    await runAlarm(collector, storage, now);
    db.rounds.get(`5:${roundId}`)!.market_id = "another-market";
    now = start * 1_000 + 365_000;
    await runAlarm(collector, storage, now);
    const evidence = [...db.evidence.values()].find(row => row.expected_round_id === roundId);
    assert.equal(evidence?.verdict, "IDENTITY_MISMATCH");
    assert.match(String(evidence?.reason), /market/);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});