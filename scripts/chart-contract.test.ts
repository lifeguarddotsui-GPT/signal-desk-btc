import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseLatestRoundTick,
  isFreshRoundComparison,
  mergeComparisonPoints,
  pointerTimestamp,
} from "../client/src/chart-contract";

test("pointer mapping accounts for the SVG plot inset and clamps at observed chart edges", () => {
  const map = (x: number) => pointerTimestamp(x, 100, 1_000, 0.142, 0.98, 10_000, 70_000);
  assert.equal(map(242), 10_000);
  assert.equal(map(1_080), 70_000);
  assert.ok(Math.abs((map(661) ?? 0) - 40_000) < 1e-8);
  assert.equal(map(100), 10_000);
  assert.equal(pointerTimestamp(0, 0, 0, 0.076, 0.98, 0, 1), null);
});

test("comparison reference must be a fresh sample inside the active round", () => {
  const roundStart = 100_000, serverNow = 150_000, clientNow = 150_100;
  assert.equal(isFreshRoundComparison(145_000, roundStart, serverNow, clientNow), true);
  assert.equal(isFreshRoundComparison(99_999, roundStart, serverNow, clientNow), false);
  assert.equal(isFreshRoundComparison(130_000, roundStart, serverNow, clientNow), false);
  assert.equal(isFreshRoundComparison("not a date", roundStart, serverNow, clientNow), false);
});

test("latest accepted tick is fresh and belongs to the active round", () => {
  const current = { point: { at: 145_000, sourceAt: 145_000, price: 100 }, roundId: "round-a" };
  const candidate = { at: 149_000, sourceAt: 149_000, price: 101 };
  assert.deepEqual(
    chooseLatestRoundTick(current, candidate, "round-a", "round-a", 100_000, 150_000, 150_100),
    { point: candidate, roundId: "round-a" },
  );
  assert.equal(chooseLatestRoundTick(current, candidate, "round-a", "round-b", 100_000, 150_000, 150_100), null);
  assert.equal(chooseLatestRoundTick(current, { ...candidate, sourceAt: 130_000 }, "round-a", "round-a", 100_000, 150_000, 150_100), null);
  assert.equal(chooseLatestRoundTick(current, { ...candidate, gap: true }, "round-a", "round-a", 100_000, 150_000, 150_100), null);
  assert.equal(chooseLatestRoundTick(null, { ...candidate, sourceAt: 159_950 }, "round-a", "round-a", 100_000, 159_900, 159_900, 14_000, 159_900), null);
  assert.deepEqual(
    chooseLatestRoundTick(current, { ...candidate, sourceAt: 140_000 }, "round-a", "round-a", 100_000, 150_000, 150_100),
    current,
  );
});

test("archive and stream merge deduplicates a repeated observation but keeps identified same-time trades", () => {
  const history = [
    { at: 1_001, sourceAt: 1_000, price: 100 },
    { at: 1_002, sourceAt: 1_000, price: 101 },
  ];
  const stream = [
    { at: 1_000, sourceAt: 1_000, price: 100, eventId: "trade-a", streamId: 1 },
    { at: 1_000, sourceAt: 1_000, price: 100, eventId: "trade-b", streamId: 2 },
  ];
  const merged = mergeComparisonPoints(history, stream);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.slice(0, 2).map(point => point.eventId), ["trade-a", "trade-b"]);
  assert.equal(merged[2].price, 101);
  assert.deepEqual(mergeComparisonPoints(history, [stream[0], stream[0]]), [
    stream[0],
    history[1],
  ]);
});