import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectedPointKey, mergeComparisonPoints, pointerTimestamp } from "./chart-contract";

test("chart inspection identity follows an event, not array position", () => {
  const inspected = { at: 1_700_000_000_000, price: 67_123.45, eventId: "evt-18" };
  assert.equal(inspectedPointKey(inspected), inspectedPointKey({ ...inspected, at: inspected.at + 1000 }));
});

test("identified same-time observations remain distinct after merging", () => {
  const at = 1_700_000_000_000;
  const merged = mergeComparisonPoints(
    [{ at, price: 67_000 }, { at, price: 67_000, eventId: "trade-a" }],
    [{ at, price: 67_000, eventId: "trade-b" }],
  );
  assert.equal(merged.filter(p => p.eventId != null).length, 2);
  assert.deepEqual(merged.map(p => p.eventId), ["trade-a", "trade-b"]);
});

test("pointer time maps to the measured plot and safely clamps touch edges", () => {
  assert.equal(pointerTimestamp(200, 100, 500, .1, .9, 0, 1000), 125);
  assert.equal(pointerTimestamp(100, 100, 500, .1, .9, 0, 1000), 0);
  assert.equal(pointerTimestamp(600, 100, 500, .1, .9, 0, 1000), 1000);
});