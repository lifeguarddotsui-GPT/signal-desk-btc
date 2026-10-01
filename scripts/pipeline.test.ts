import test from "node:test";
import assert from "node:assert/strict";
import {
  isCurrentUnexpiredRound,
  nextPrimaryCaptureDelayMs,
  primaryDecisionWindow,
  snapshotBucketWidthMs,
} from "../server/btc/policy";
import {
  inferWithShadowFallback,
  ShadowInferenceError,
  snapshotIdForObservation,
} from "../server/btc/store";

test("targeted sampling enters, retries inside, and stops at the unchanged primary horizon", () => {
  const expiry = 1_800_000_000_000;
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 60_000), 16_000);
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 45_000), 2_500);
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 31_000), 1_000);
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 30_000), null);
  assert.equal(primaryDecisionWindow(expiry - 45_000, expiry), true);
  assert.equal(primaryDecisionWindow(expiry - 30_000, expiry), true);
  assert.equal(primaryDecisionWindow(expiry - 29_999, expiry), false);
});

test("restart recovery reconstructs the next capture from the round expiry", () => {
  const expiry = 1_800_000_000_000;
  // A new process has no persisted timer state. Recomputing from the known
  // round still schedules a fresh read before the strict window closes.
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 38_000), 2_500);
  assert.equal(nextPrimaryCaptureDelayMs(expiry, expiry - 30_500), 500);
});

test("targeted capture rejects a stale timer after round rollover or expiry", () => {
  const oldRound = { id: "round-A", expiryMs: 1_800_000_000_000 };
  const nextRound = { id: "round-B", expiryMs: oldRound.expiryMs + 60_000 };
  assert.equal(isCurrentUnexpiredRound(oldRound.id, oldRound.expiryMs, oldRound, oldRound.expiryMs - 40_000), true);

  // This gate is checked after the asynchronous quote read and again directly
  // before persistence, so a timer for A cannot fall back to its stale copy.
  assert.equal(isCurrentUnexpiredRound(oldRound.id, oldRound.expiryMs, nextRound, oldRound.expiryMs - 40_000), false);
  assert.equal(isCurrentUnexpiredRound(oldRound.id, oldRound.expiryMs, null, oldRound.expiryMs - 40_000), false);
  assert.equal(isCurrentUnexpiredRound(oldRound.id, oldRound.expiryMs, {
    id: oldRound.id, expiryMs: oldRound.expiryMs + 1,
  }, oldRound.expiryMs - 40_000), false);
  assert.equal(isCurrentUnexpiredRound(oldRound.id, oldRound.expiryMs, oldRound, oldRound.expiryMs), false);
});

test("primary-window retry IDs are idempotent per bucket and immutable across retries", () => {
  const expiry = 1_800_000_000_000;
  const roundId = "round-A";
  const firstAt = expiry - 42_000;
  assert.equal(snapshotBucketWidthMs(firstAt, expiry), 3_000);
  const firstId = snapshotIdForObservation(roundId, firstAt, expiry);
  assert.equal(snapshotIdForObservation(roundId, firstAt + 500, expiry), firstId);
  assert.notEqual(snapshotIdForObservation(roundId, firstAt + 3_100, expiry), firstId);

  const inserted = new Map<string, { up: number | null }>();
  for (const value of [null, null, .62]) {
    const id = snapshotIdForObservation(roundId, firstAt, expiry);
    if (!inserted.has(id)) inserted.set(id, { up: value });
  }
  assert.equal(inserted.size, 1);
  assert.equal(inserted.get(firstId)?.up, null);
  const retryId = snapshotIdForObservation(roundId, firstAt + 3_100, expiry);
  inserted.set(retryId, { up: .62 });
  assert.equal(inserted.get(firstId)?.up, null);
  assert.equal(inserted.get(retryId)?.up, .62);
});

test("ordinary observations keep the existing 15-second deduplication bucket", () => {
  const expiry = 1_800_000_000_000;
  const outsideWindow = Math.floor((expiry - 60_000) / 15_000) * 15_000 + 5_000;
  assert.equal(snapshotBucketWidthMs(outsideWindow, expiry), 15_000);
  assert.equal(
    snapshotIdForObservation("round-A", outsideWindow, expiry),
    snapshotIdForObservation("round-A", outsideWindow + 7_500, expiry),
  );
});

test("incompatible shadow inference falls back to the immutable baseline but SQL failures still abort", async () => {
  const invalidArtifact = await inferWithShadowFallback(async () => {
    throw new ShadowInferenceError("Shadow artifact version quarantined: schema mismatch");
  });
  assert.equal(invalidArtifact.result, null);
  assert.match(invalidArtifact.error ?? "", /quarantined/);

  await assert.rejects(
    inferWithShadowFallback(async () => {
      throw new Error("database connection lost");
    }),
    /database connection lost/,
  );
});