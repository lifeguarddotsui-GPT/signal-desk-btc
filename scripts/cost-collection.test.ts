import test from "node:test";
import assert from "node:assert/strict";
import { lockPolicy } from "../shared/lock-readiness";
import {
  adaptiveWaterxPollIntervalMs, WATERX_DECISION_LEAD_MS,
  WATERX_DECISION_POLL_MS, WATERX_IDLE_POLL_MS,
} from "../server/waterx/poll-policy";
import {
  archiveSamplePeriodMs, createComparisonArchiveSampler,
  DEFAULT_COMPARISON_ARCHIVE_SAMPLE_MS,
} from "../server/btc/chart-sampling";

for (const interval of [5, 15] as const) {
  test(`${interval}m adaptive polling retains lock stability and exact checkpoints`, () => {
    const policy = lockPolicy(interval);
    assert.ok(WATERX_IDLE_POLL_MS[interval] <= (interval === 5 ? 16_000 : 31_000) - 5_000);
    const maxWindowMs = Math.max(...policy.windows) * 1_000;
    assert.ok(WATERX_DECISION_LEAD_MS[interval] >=
      maxWindowMs + policy.earlyPersistenceMs + WATERX_IDLE_POLL_MS[interval] + 5_000);
    const expiry = 1_800_000_900_000;
    // The entire lock formation window uses a cadence below maxGapMs and maxAgeMs.
    for (let remaining = 0; remaining <= maxWindowMs; remaining += 1_000)
      assert.equal(adaptiveWaterxPollIntervalMs(interval, expiry, expiry - remaining),
        WATERX_DECISION_POLL_MS);
    assert.ok(WATERX_DECISION_POLL_MS < policy.maxGapMs);
    assert.ok(WATERX_DECISION_POLL_MS < policy.maxAgeMs);
  });

  test(`${interval}m idle and rollover schedule uses fewer provider calls`, () => {
    const expiry = 1_800_000_900_000;
    const duration = interval * 60_000;
    assert.equal(adaptiveWaterxPollIntervalMs(interval, null, expiry - duration),
      WATERX_IDLE_POLL_MS[interval]);
    assert.equal(adaptiveWaterxPollIntervalMs(interval, expiry, expiry - duration),
      WATERX_IDLE_POLL_MS[interval]);
    assert.equal(adaptiveWaterxPollIntervalMs(interval, expiry, expiry + 5_000),
      WATERX_DECISION_POLL_MS);
    assert.equal(adaptiveWaterxPollIntervalMs(interval, expiry, expiry + 20_000),
      WATERX_IDLE_POLL_MS[interval]);
    let adaptiveReads = 0, clock = expiry - duration;
    while (clock < expiry) {
      const delay = adaptiveWaterxPollIntervalMs(interval, expiry, clock);
      assert.ok(delay > 0);
      adaptiveReads++;
      clock += delay;
    }
    const legacyReads = Math.ceil((duration - (interval === 5 ? 120_000 : 360_000))/5_000) +
      Math.ceil((interval === 5 ? 120_000 : 360_000)/3_000);
    assert.ok(adaptiveReads < legacyReads,
      `adaptive=${adaptiveReads}, legacy=${legacyReads}`);
  });
}

test("archive only accepts bounded genuine timestamps, without fabricating samples", () => {
  const sampler = createComparisonArchiveSampler();
  const start = 1_800_000_000_000;
  assert.equal(sampler.shouldQueue(start), true);
  sampler.markQueued(start);
  assert.equal(sampler.shouldQueue(start + 100), false);
  assert.equal(sampler.shouldQueue(start + 4_999), false);
  assert.equal(sampler.shouldQueue(start + 5_000), true);
  sampler.markQueued(start + 5_000);
  assert.equal(sampler.shouldQueue(start + 4_000), false);
  assert.equal(sampler.shouldQueue(Number.NaN), false);
  assert.equal(sampler.shouldQueue(start + 10_000), true);
  assert.throws(() => sampler.markQueued(start), RangeError);
});

test("archive writer rejection does not suppress the next authentic event", () => {
  const sampler = createComparisonArchiveSampler();
  const start = 1_800_000_000_000;
  assert.equal(sampler.shouldQueue(start), true); // pretend queue rejected
  assert.equal(sampler.shouldQueue(start + 200), true);
  sampler.markQueued(start + 200);
  assert.equal(sampler.shouldQueue(start + 300), false);
});

test("emergency rollback restores every accepted event to database queue", () => {
  assert.equal(archiveSamplePeriodMs(undefined), DEFAULT_COMPARISON_ARCHIVE_SAMPLE_MS);
  assert.equal(archiveSamplePeriodMs("false"), 0);
  const sampler = createComparisonArchiveSampler(archiveSamplePeriodMs("false"));
  const t = 1_800_000_000_000;
  assert.equal(sampler.shouldQueue(t), true);
  sampler.markQueued(t);
  assert.equal(sampler.shouldQueue(t + 1), true);
  assert.throws(() => createComparisonArchiveSampler(-1), RangeError);
});
