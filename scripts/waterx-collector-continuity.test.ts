import test from "node:test";
import assert from "node:assert/strict";
import { createWaterxBackgroundQueue } from "../server/waterx/background-queue";
import { startWaterxCapture } from "../server/waterx/service";
import { waterxFetchFinished, waterxFetchStarted, waterxFetchSucceeded } from "../server/waterx/diagnostics";
import type { WaterxInterval } from "../server/waterx/types";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("unresolved persistence cannot pin either live interval's polling promise", async () => {
  let release!: () => void;
  const stalledDatabase = new Promise<void>(resolve => { release = resolve; });
  const stored: string[] = [];
  const queue = createWaterxBackgroundQueue<{
    intervalMinutes: WaterxInterval; roundId: string;
  }>(async input => {
    stored.push(input.roundId);
    if (input.roundId === "first-5m") await stalledDatabase;
  }, () => assert.fail("Unexpected persistence error"));
  const attempts = new Map<WaterxInterval, number>([[5, 0], [15, 0]]);
  const stop = startWaterxCapture({
    poll: async interval => {
      const count = (attempts.get(interval) ?? 0) + 1;
      attempts.set(interval, count);
      queue.enqueue({ intervalMinutes: interval, roundId: `${count === 1 ? "first" : "latest"}-${interval}m` });
    },
    periods: { 5: 15, 15: 25 },
    watchdogPeriodMs: 1_000,
  });
  try {
    await wait(100);
    assert.ok((attempts.get(5) ?? 0) >= 3, "5m polling must not wait for persistence");
    assert.ok((attempts.get(15) ?? 0) >= 2, "15m polling must remain independent");
    assert.ok(stored.includes("first-5m"));
    assert.ok(stored.includes("first-15m"));
    assert.equal(queue.pending.get(5)?.roundId, "latest-5m");
    release();
    await wait(10);
    assert.ok(stored.includes("latest-5m"), "newest pending round must persist after recovery");
  } finally {
    release();
    stop();
  }
});

test("an unexpected poll exception still schedules both intervals again", async () => {
  const attempts = new Map<WaterxInterval, number>([[5, 0], [15, 0]]);
  const stop = startWaterxCapture({
    poll: async interval => {
      const count = (attempts.get(interval) ?? 0) + 1;
      attempts.set(interval, count);
      if (count === 1) throw new Error("simulated unexpected error");
    },
    periods: { 5: 15, 15: 20 },
    retryDelayMs: 15,
    watchdogPeriodMs: 1_000,
  });
  try {
    await wait(80);
    assert.ok((attempts.get(5) ?? 0) >= 2);
    assert.ok((attempts.get(15) ?? 0) >= 2);
  } finally {
    stop();
  }
});

test("watchdog restarts a vanished timer and reports a genuinely stuck read once", async () => {
  const attempts = new Map<WaterxInterval, number>([[5, 0], [15, 0]]);
  let stalledReports = 0;
  waterxFetchSucceeded(15, { id: "watchdog-reset", startsAt: Math.floor(Date.now() / 1000) }, Date.now());
  waterxFetchStarted(15, Date.now() - 65_000);
  waterxFetchFinished(15);
  const stop = startWaterxCapture({
    poll: async interval => {
      attempts.set(interval, (attempts.get(interval) ?? 0) + 1);
      if (interval === 5) {
        waterxFetchStarted(5, Date.now() - 65_000);
        await new Promise<void>(() => {});
      }
    },
    periods: { 5: 200, 15: 200 },
    retryDelayMs: 200,
    watchdogPeriodMs: 15,
    onStalled: interval => {
      assert.equal(interval, 5);
      stalledReports += 1;
    },
  });
  try {
    await wait(75);
    assert.equal(stalledReports, 1);
    assert.ok((attempts.get(15) ?? 0) >= 2, "15m must recover its missing timer");
    assert.equal(attempts.get(5), 1, "a stuck read must never run concurrently");
  } finally {
    stop();
    waterxFetchFinished(5);
  }
});