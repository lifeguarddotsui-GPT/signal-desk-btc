import assert from "node:assert/strict";
import test from "node:test";
import {
  boundArchivePoints,
  COMPARISON_ARCHIVE_MAX_POINTS,
  COMPARISON_ARCHIVE_MAX_ROWS,
  comparisonSeriesCoverage,
  createComparisonTickWriter,
  persistedComparisonArchive,
} from "../server/btc/chart-history";

test("comparison archive queries source timestamps over the requested 15-minute window", async () => {
  const now = 1_800_000_000_000;
  let queryText = "";
  let queryValues: unknown[] = [];
  const result = await persistedComparisonArchive(15, now, async (sql, values) => {
    if (sql.includes("btc_predict_snapshots")) return { rows: [] };
    queryText = sql;
    queryValues = values;
    return {
      rows: [
        { id: "tick-new", event_id: "trade-new", received_at: new Date(now),
          source_at: new Date(now - 1_000), price: "60100", source: "Coinbase" },
        { id: "tick-old", received_at: new Date(now - 898_000), source_at: new Date(now - 899_000), price: "60000", source: "Coinbase" },
      ],
    };
  });

  assert.match(queryText, /source_at >= \$1 AND source_at <= \$2/);
  assert.match(queryText, /ORDER BY source_at DESC/);
  assert.equal(queryValues[0], new Date(now - 15 * 60_000).toISOString());
  assert.equal(queryValues[1], new Date(now).toISOString());
  assert.equal(queryValues[2], COMPARISON_ARCHIVE_MAX_ROWS + 1);
  assert.deepEqual(result.points.map(point => point.at), [now - 899_000, now - 1_000]);
  assert.deepEqual(result.points.map(point => point.sourceAt), [
    new Date(now - 899_000).toISOString(),
    new Date(now - 1_000).toISOString(),
  ]);
  assert.deepEqual(result.points.map(point => point.archiveId), ["tick-old", "trade-new"]);
  assert.equal(result.points[1].eventId, "trade-new");
  assert.equal(result.points[0].observedAt, new Date(now - 898_000).toISOString());
  assert.equal(result.coverage.status, "available");
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.oldestSourceAt, new Date(now - 899_000).toISOString());
});

test("an unmigrated tick archive retains sparse legacy history with an explicit label", async () => {
  const now = 1_800_000_000_000;
  const result = await persistedComparisonArchive(5, now, async sql => {
    if (sql.includes("waterx_comparison_ticks")) throw Object.assign(new Error("missing relation"), { code: "42P01" });
    return { rows: [{ id: "old", observed_at: new Date(now - 30_000),
      comparison_at: new Date(now - 31_000), comparison_price: "60000" }] };
  });
  assert.equal(result.coverage.status, "partial");
  assert.equal(result.coverage.archiveSource, "legacy_snapshots");
  assert.match(result.coverage.reason ?? "", /schema is not installed/);
  assert.deepEqual(result.points.map(point => point.price), [60000]);
});

test("time-bucket reduction retains source edges and extrema without interpolating", () => {
  const start = 1_800_000_000_000;
  const input = Array.from({ length: 8_000 }, (_, index) => ({
    at: start + index * 100,
    price: 60_000 + (index % 11),
    sourceAt: new Date(start + index * 100).toISOString(),
    archiveId: `snapshot-${index}`,
  }));
  input[0].price = 50_000;
  input[input.length - 1].price = 70_000;
  const result = boundArchivePoints(input, COMPARISON_ARCHIVE_MAX_POINTS, start, start + 15 * 60_000);

  assert.ok(result.length <= COMPARISON_ARCHIVE_MAX_POINTS);
  assert.equal(result[0].archiveId, input[0].archiveId);
  assert.equal(result.at(-1)?.archiveId, input.at(-1)?.archiveId);
  assert.ok(result.some(point => point.price === 50_000));
  assert.ok(result.some(point => point.price === 70_000));
  assert.ok(result.every(point => input.some(source => source.archiveId === point.archiveId)));
  assert.equal(result.some(point => !input.some(source => source.at === point.at)), false);
});

test("archive coverage identifies row-cap truncation and unavailable storage", async () => {
  const now = 1_800_000_000_000;
  const overflow = Array.from({ length: COMPARISON_ARCHIVE_MAX_ROWS + 1 }, (_, index) => ({
    id: `snapshot-${index}`,
    received_at: new Date(now - index * 10),
    source_at: new Date(now - index * 10),
    price: String(60_000 + index),
    source: "Coinbase",
  }));
  const partial = await persistedComparisonArchive(15, now, async sql =>
    sql.includes("btc_predict_snapshots") ? { rows: [] } : { rows: overflow });
  assert.equal(partial.coverage.status, "partial");
  assert.equal(partial.coverage.truncated, true);
  assert.match(partial.coverage.reason ?? "", /read cap/);
  assert.ok(partial.coverage.oldestSourceAt);
  assert.ok(partial.coverage.newestSourceAt);

  const unavailable = await persistedComparisonArchive(5, now, async () => {
    throw new Error("database offline");
  });
  assert.deepEqual(unavailable.points, []);
  assert.equal(unavailable.coverage.status, "unavailable");
  assert.equal(unavailable.coverage.truncated, false);
  assert.match(unavailable.coverage.reason ?? "", /database offline/);
});

test("tick persistence survives writer restart and deduplicates provider events", async () => {
  const durableRows = new Map<string, { id: string; source_at: Date; received_at: Date; price: string }>();
  const tick = {
    price: 60_123,
    sourceAt: new Date(1_800_000_000_000).toISOString(),
    receivedAt: new Date(1_800_000_000_050).toISOString(),
    source: "Coinbase Exchange BTC-USD",
    eventId: "BTC-USD:trade:44",
    sourceToServerLatencyMs: 50,
  };
  const write = async (value: typeof tick) => {
    if (!durableRows.has(value.eventId)) {
      durableRows.set(value.eventId, {
        id: value.eventId, source_at: new Date(value.sourceAt),
        received_at: new Date(value.receivedAt), price: String(value.price),
      });
    }
  };
  const firstWriter = createComparisonTickWriter(write);
  firstWriter.enqueue(tick);
  await firstWriter.drain();
  const restartedWriter = createComparisonTickWriter(write);
  restartedWriter.enqueue(tick);
  await restartedWriter.drain();

  const archive = await persistedComparisonArchive(5, 1_800_000_000_100, async sql => {
    assert.match(sql, /waterx_comparison_ticks/);
    return { rows: Array.from(durableRows.values()).map(row => ({
      ...row, source: tick.source, event_id: tick.eventId,
    })) };
  });
  assert.equal(durableRows.size, 1);
  assert.equal(archive.points.length, 1);
  assert.equal(archive.points[0].sourceAt, tick.sourceAt);
  assert.equal(archive.points[0].observedAt, tick.receivedAt);
  assert.equal(archive.points[0].archiveId, tick.eventId);
});

test("legacy snapshots are labeled and confined to the prefix before fresh Coinbase ticks", async () => {
  const now = 1_800_000_000_000;
  const start = now - 5 * 60_000;
  const firstTickAt = now - 30_000;
  const archive = await persistedComparisonArchive(5, now, async (sql, values) => {
    if (sql.includes("waterx_comparison_ticks")) return {
      rows: [{
        id: "new-tick", source_at: new Date(firstTickAt), received_at: new Date(firstTickAt + 20),
        price: "60100", source: "Coinbase", event_id: "trade-1",
      }],
    };
    assert.match(sql, /comparison_at >= \$1 AND comparison_at < \$2/);
    assert.equal(values[1], new Date(firstTickAt).toISOString());
    return {
      rows: [{
        id: "old-snapshot", observed_at: new Date(start + 2_000),
        comparison_at: new Date(start + 1_000), comparison_price: "60000",
      }],
    };
  });
  assert.equal(archive.coverage.archiveSource, "coinbase_ticks+legacy_snapshots");
  assert.equal(archive.coverage.status, "partial");
  assert.match(archive.coverage.reason ?? "", /older prefix/);
  assert.deepEqual(archive.points.map(point => point.archiveId), ["legacy:old-snapshot", "trade-1"]);
  assert.deepEqual(archive.points.map(point => point.sourceAt), [
    new Date(start + 1_000).toISOString(), new Date(firstTickAt).toISOString(),
  ]);
  assert.ok(archive.points.every(point => point.at < firstTickAt || point.at === firstTickAt));
});

test("archive write queue is bounded and reports dropped ticks", async () => {
  let releaseWrite!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writer = createComparisonTickWriter(async () => blockedWrite, 1);
  const first = {
    price: 60_000, sourceAt: new Date(1_800_000_000_000).toISOString(),
    receivedAt: new Date(1_800_000_000_000).toISOString(), source: "Coinbase",
    eventId: "bounded-1", sourceToServerLatencyMs: 0,
  };
  assert.equal(writer.enqueue(first), true);
  assert.equal(writer.enqueue({ ...first, eventId: "bounded-2" }), false);
  assert.equal(writer.health().queueDepth, 1);
  assert.equal(writer.health().droppedTicks, 1);
  assert.equal(writer.health().status, "degraded");
  releaseWrite();
  await writer.drain();
});

test("database write failure is explicit and remains queued for retry", async () => {
  const writer = createComparisonTickWriter(async () => { throw new Error("database offline"); }, 2);
  writer.enqueue({
    price: 60_000,
    sourceAt: new Date(1_800_000_000_000).toISOString(),
    receivedAt: new Date(1_800_000_000_000).toISOString(),
    source: "Coinbase",
    sourceToServerLatencyMs: 0,
  });
  await writer.drain();
  assert.equal(writer.health().status, "degraded");
  assert.equal(writer.health().queueDepth, 1);
  assert.match(writer.health().lastFailure ?? "", /database offline/);

  const unavailable = await persistedComparisonArchive(5, 1_800_000_000_000, async () => {
    throw new Error("waterx_comparison_ticks does not exist");
  });
  assert.equal(unavailable.coverage.status, "unavailable");
  assert.match(unavailable.coverage.reason ?? "", /does not exist/);
});

test("archive-plus-stream coverage reports actual span and internal gaps without claiming completeness", () => {
  const start = 1_800_000_000_000;
  const end = start + 15 * 60_000;
  const base = {
    status: "available" as const,
    requestedStartAt: new Date(start).toISOString(),
    requestedEndAt: new Date(end).toISOString(),
    oldestSourceAt: null,
    newestSourceAt: null,
    returnedPoints: 0,
    truncated: false,
    persistence: {
      status: "healthy" as const, queueDepth: 0, droppedTicks: 0,
      lastSuccessAt: null, lastFailure: null,
    },
  };
  const fullSpanWithGap = comparisonSeriesCoverage([
    { at: start, price: 60_000, sourceAt: new Date(start).toISOString() },
    { at: start + 7 * 60_000, price: null, gap: true },
    { at: end, price: 60_100, sourceAt: new Date(end).toISOString() },
  ], base, start, end);
  assert.equal(fullSpanWithGap.observationSpanMs, 15 * 60_000);
  assert.equal(fullSpanWithGap.requestedDurationMs, 15 * 60_000);
  assert.equal(fullSpanWithGap.gapCount, 1);
  assert.equal(fullSpanWithGap.status, "partial");
  assert.match(fullSpanWithGap.measurement, /no continuity is implied/);

  const incomplete = comparisonSeriesCoverage([
    { at: start + 2 * 60_000, price: 60_000 },
    { at: start + 3 * 60_000, price: 60_100 },
  ], base, start, end);
  assert.equal(incomplete.observationSpanMs, 60_000);
  assert.equal(incomplete.missingStartMs, 2 * 60_000);
  assert.equal(incomplete.missingEndMs, 12 * 60_000);
  assert.equal(incomplete.status, "partial");
});