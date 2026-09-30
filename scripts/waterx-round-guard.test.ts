import assert from "node:assert/strict";
import test from "node:test";
import { shouldKeepActiveRoundOnFuture } from "../server/waterx/service";
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