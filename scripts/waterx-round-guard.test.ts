import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateWaterxRetryDelay, shouldKeepActiveRoundOnFuture,
} from "../server/waterx/service";
import { WaterxProviderError } from "../server/waterx/source";
import type { WaterxRound } from "../server/waterx/types";

test("an early future-round preview cannot hide a still-active observed round", () => {
  const start = 1_800_000_000;
  const now = (start + 150) * 1000;
  const round = { startsAt: start, endsAt: start + 300 } as WaterxRound;
  const previous = {
    observedAt: new Date(now).toISOString(), status: "LIVE" as const,
    round, reason: "Active", sourceError: null,
  };
  assert.equal(shouldKeepActiveRoundOnFuture(previous, start + 300, now), true);
  assert.equal(shouldKeepActiveRoundOnFuture(previous, start + 300, (start + 301) * 1000), false);
  assert.equal(shouldKeepActiveRoundOnFuture({ ...previous, status: "STALE" }, start + 300, now), false);
});

test("independent retry backoff and provider rate limits are bounded and deterministic", () => {
  assert.equal(calculateWaterxRetryDelay(5, new Error("offline"), 1, 0), 4_500);
  assert.equal(calculateWaterxRetryDelay(15, new Error("offline"), 1, 1), 11_000);
  assert.equal(calculateWaterxRetryDelay(
    5, new WaterxProviderError("429", 429, 9_000), 1, 1,
  ), 10_800);
  assert.equal(calculateWaterxRetryDelay(
    5, new WaterxProviderError("429", 429, 300_000), 1, 1,
  ), 360_000);
});