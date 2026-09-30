import test from "node:test";
import assert from "node:assert/strict";
import { selectWaterxOddsDisplay } from "../client/src/waterx-ui-contract";

test("a current one-sided price supports indicative arithmetic even with no reference or probability", () => {
  const now = 1_800_000_000_000;
  const result = selectWaterxOddsDisplay({
    snapshotCurrent: true, roundCurrent: true, requestedInterval: 5,
    responseInterval: 5, roundId: "round-a", roundStartMs: now - 5000,
    serverNowMs: now,
    odds: { up: null, down: null, upPriceCents: 40, downPriceCents: null,
      asOf: new Date(now - 1000).toISOString(), source: "WaterX public market probabilities and odds" },
    availability: {
      status: "unavailable",
      up: { side: "reported", price: "reported", pricePositive: true, probability: "unavailable" },
      down: { side: "unavailable", price: "unavailable", probability: "unavailable" },
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.up.probability, null);
  assert.equal(result.up.grossAvailable, true);
  assert.equal(result.down.grossAvailable, false);
});