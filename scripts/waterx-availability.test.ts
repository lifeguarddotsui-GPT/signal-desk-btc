import assert from "node:assert/strict";
import test from "node:test";
import { assessAvailability, checkAvailability } from "./check-waterx-availability.mjs";

const now = 1_800_000_000_000;
test("fresh Coinbase cannot mask a sustained stale WaterX round", () => {
  const result = assessAvailability(5, { status: "STALE", comparison: { price: 80_000 } },
    { collector: { lastValidObservationAt: new Date(now - 180_000).toISOString(), healthState: "STALLED" } }, now);
  assert.equal(result.sustainedStale, true);
});
test("a fresh identity-matched live WaterX round is not stale", () => {
  const result = assessAvailability(15, {
    intervalMinutes: 15, status: "LIVE", round: { startMs: now - 5000, expiryMs: now + 30_000 },
  }, { collector: { lastValidObservationAt: new Date(now - 1000).toISOString() } }, now);
  assert.equal(result.sustainedStale, false);
});
test("external monitoring fails explicitly on HTTP and missing liveness", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  const result = await checkAvailability("https://example.com", fakeFetch, now);
  assert.equal(result.alert, true);
  assert.equal(result.failures.length, 5);
  await assert.rejects(checkAvailability("https://name:password@example.com", fakeFetch, now), /without credentials/);
});