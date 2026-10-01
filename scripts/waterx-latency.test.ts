import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLatency } from "../server/waterx/latency";

test("latency reports sample count, duration and interpolated percentiles without inventing missing stages", () => {
  const start = 1_800_000_000_000;
  const samples = [1, 2, 3, 4, 5].map((latencyMs, index) => ({
    at: start + index * 60_000, latencyMs,
  }));
  const report = summarizeLatency(samples, "Clock uncertainty applies.");
  assert.equal(report.status, "measured");
  assert.equal(report.sampleCount, 5);
  assert.equal(report.observedFrom, new Date(start).toISOString());
  assert.equal(report.observedUntil, new Date(start + 4 * 60_000).toISOString());
  assert.equal(report.p50Ms, 3);
  assert.equal(report.p95Ms, 4.8);
  assert.equal(report.p99Ms, 4.96);
  assert.equal(summarizeLatency([]).status, "unavailable");
  assert.equal(summarizeLatency([{ at: start, latencyMs: -3 }]).sampleCount, 0);
});