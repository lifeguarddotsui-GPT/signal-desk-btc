import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChartSeries,
  CHART_WINDOW_MS,
  chartReplayPlan,
  COMPARISON_SOURCE,
  createPriceCapture,
  type ChartSample,
} from "../server/btc/chart";

const tick = (price: number, at: number) => ({
  price,
  asOf: new Date(at).toISOString(),
  source: "Coinbase Exchange BTC-USD (comparison only; not settlement oracle)",
});

test("in-memory retention is bounded and expires old observations", () => {
  let now = 1_800_000_000_000;
  const capture = createPriceCapture({ now: () => now, maxPoints: 3 });
  for (let i = 0; i < 4; i++) {
    now += 4_000;
    assert.equal(capture.accept(tick(60_000 + i, now)), true);
  }

  assert.deepEqual(capture.getPoints().map(point => point.price), [60_001, 60_002, 60_003]);
  now += 11 * 60_000;
  assert.equal(capture.accept(tick(61_000, now)), true);
  assert.deepEqual(capture.getPoints().map(point => point.price), [61_000]);
});

test("series preserves gaps as null markers without fabricating prices", () => {
  const now = 1_800_000_000_000;
  const captured: ChartSample[] = [
    { at: now - 40_000, price: 60_000, source: COMPARISON_SOURCE,
      sourceAt: new Date(now - 40_000).toISOString(), sourceAgeMs: 0,
      receivedAt: new Date(now - 40_000).toISOString(),
      serverEventAt: new Date(now - 40_000).toISOString(), sourceToServerLatencyMs: 0 },
    { at: now - 1_000, price: 60_100, source: COMPARISON_SOURCE,
      sourceAt: new Date(now - 1_000).toISOString(), sourceAgeMs: 0,
      receivedAt: new Date(now - 1_000).toISOString(),
      serverEventAt: new Date(now - 1_000).toISOString(), sourceToServerLatencyMs: 0 },
  ];
  const result = buildChartSeries([
    { at: now - CHART_WINDOW_MS - 1, price: 59_000 },
    { at: now - 30_000, price: 60_050 },
  ], captured, now);

  assert.equal(result.some(point => point.at === now - CHART_WINDOW_MS - 1), false);
  const gaps = result.filter(point => "gap" in point);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].price, null);
  assert.equal(result.filter(point => point.price !== null).length, 3);
});

test("timestamps remain continuous across a round rollover", () => {
  let now = 1_800_000_000_000;
  const expiry = now + 2_000;
  const capture = createPriceCapture({ now: () => now });
  assert.equal(capture.accept(tick(60_000, now)), true);
  now += 4_000;
  assert.equal(capture.accept(tick(60_010, now)), true);

  const series = buildChartSeries([], capture.getPoints(), now);
  assert.deepEqual(series.filter(point => point.price !== null).map(point => point.price), [60_000, 60_010]);
  assert.equal(series.some(point => "gap" in point), false);
  assert.ok(series[0].at < expiry && series[1].at > expiry);
});

test("stale and duplicate provider ticks are rejected and source age is exposed", () => {
  const now = 1_800_000_000_000;
  const capture = createPriceCapture({ now: () => now });
  const current = tick(60_000, now - 2_000);

  assert.equal(capture.accept(current), true);
  assert.equal(capture.accept(current), false);
  assert.equal(capture.accept(tick(60_001, now - 21_000)), false);
  assert.equal(capture.accept(tick(60_002, now + 3_000)), false);
  assert.equal(capture.getPoints().length, 1);
  assert.equal(capture.getPoints()[0].sourceAgeMs, 2_000);
});

test("source event and server receipt times remain separate with measured ingestion latency", () => {
  const receivedAt = 1_800_000_000_000;
  const capture = createPriceCapture({ now: () => receivedAt });
  assert.equal(capture.accept(tick(60_000, receivedAt - 1_375)), true);
  const point = capture.getPoints()[0];
  assert.equal(point.at, receivedAt);
  assert.equal(point.sourceAt, new Date(receivedAt - 1_375).toISOString());
  assert.equal(point.receivedAt, new Date(receivedAt).toISOString());
  assert.equal(point.serverEventAt, point.receivedAt);
  assert.equal(point.sourceToServerLatencyMs, 1_375);
});

test("provider events arriving out of order cannot rewind the chart", () => {
  const now = 1_800_000_000_000;
  const capture = createPriceCapture({ now: () => now });
  assert.equal(capture.accept(tick(60_010, now - 1_000)), true);
  assert.equal(capture.accept(tick(60_005, now - 2_000)), false);
  assert.deepEqual(capture.getPoints().map(point => point.price), [60_010]);
});

test("SSE reconnect cursor from prior process resets and then replays the new process", () => {
  const retained = [{ id: 1 }, { id: 2 }];
  const replay = chartReplayPlan(240, 2, retained[0].id);
  assert.deepEqual(replay, { reset: "restart", cursor: 0 });
  assert.deepEqual(retained.filter(event => event.id > replay.cursor).map(event => event.id), [1, 2]);

  // A restarted server can have no events yet; resetting to ID 0 makes its
  // first tick (ID 1) deliverable instead of being discarded as an old cursor.
  const empty = chartReplayPlan(240, 0, undefined);
  assert.deepEqual(empty, { reset: "restart", cursor: 0 });
  assert.ok(1 > empty.cursor);
});

test("archived source age stays explicitly unknown", () => {
  const now = 1_800_000_000_000;
  const series = buildChartSeries([{ at: now - 1_000, price: 60_000 }], [], now);
  assert.equal(series[0].source, COMPARISON_SOURCE);
  assert.equal(series[0].sourceAgeMs, null);
  assert.equal(series[0].sourceAt, null);
});

test("archived provider timestamps remain distinct from app capture timestamps", () => {
  const now = 1_800_000_000_000;
  const series = buildChartSeries([{
    at: now - 1_000, price: 60_000,
    sourceAt: new Date(now - 4_000).toISOString(),
  }], [], now);
  assert.equal(series[0].sourceAt, new Date(now - 4_000).toISOString());
  assert.equal(series[0].sourceAgeMs, 4_000);
});

test("a stopped feed adds a terminal gap without inventing a later price", () => {
  const now = 1_800_000_000_000;
  const series = buildChartSeries([{ at: now - 40_000, price: 60_000 }], [], now);
  assert.equal(series.at(-1)?.price, null);
  assert.equal(series.filter(point => point.price !== null).length, 1);
});