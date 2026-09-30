import assert from "node:assert/strict";
import test from "node:test";
import {
  selectWaterxOddsDisplay,
  selectWaterxPriceDistance,
  selectWaterxReference,
} from "./waterx-ui-contract";

const activeOddsInput = () => ({
  snapshotCurrent: true,
  roundCurrent: true,
  requestedInterval: 5 as const,
  responseInterval: 5,
  roundId: "active-round",
  roundStartMs: 1_000,
  serverNowMs: 10_000,
  odds: {
    up: 0,
    down: 1,
    upPriceCents: 45,
    downPriceCents: 55,
    asOf: new Date(9_000).toISOString(),
    source: "WaterX public market probabilities and odds",
    roundId: "active-round",
  },
  availability: {
    status: "available",
    up: { probability: "available", price: "available", pricePositive: true, side: "reported" },
    down: { probability: "available", price: "available", pricePositive: true, side: "reported" },
  },
});

test("null, zero, unavailable, and stale references cannot anchor or produce a distance", () => {
  assert.equal(selectWaterxReference(true, null), null);
  assert.equal(selectWaterxReference(true, 0), null);
  assert.equal(selectWaterxReference(false, 100), null);
  assert.equal(selectWaterxReference(true, 100, "unavailable"), null);
  assert.equal(selectWaterxReference(true, 100), 100);

  assert.equal(selectWaterxPriceDistance({
    referencePrice: null,
    comparisonFresh: true,
    comparisonPrice: 101,
    comparisonAtMs: 9_000,
    roundStartMs: 1_000,
  }), null);
  assert.equal(selectWaterxPriceDistance({
    referencePrice: 100,
    comparisonFresh: false,
    comparisonPrice: 101,
    comparisonAtMs: 9_000,
    roundStartMs: 1_000,
  }), null);
  assert.deepEqual(selectWaterxPriceDistance({
    referencePrice: 100,
    comparisonFresh: true,
    comparisonPrice: 101,
    comparisonAtMs: 9_000,
    roundStartMs: 1_000,
  }), { distance: 1, percent: 1 });
});

test("a fresh numeric zero probability remains a valid market probability", () => {
  const selected = selectWaterxOddsDisplay(activeOddsInput());
  assert.equal(selected.fresh, true);
  assert.equal(selected.up.probability, 0);
  assert.equal(selected.down.probability, 1);
  assert.equal(selected.up.grossAvailable, true);
});

test("same-round market payout arithmetic does not depend on a WaterX reference price", () => {
  const input = activeOddsInput();
  const withoutReference = selectWaterxOddsDisplay(input);
  assert.equal(withoutReference.fresh, true);
  assert.equal(withoutReference.up.probability, 0);
  assert.equal(withoutReference.up.grossAvailable, true);
  assert.equal(withoutReference.down.grossAvailable, true);

  const mismatchedRound = selectWaterxOddsDisplay({
    ...input,
    roundId: "different-round",
  });
  assert.equal(mismatchedRound.fresh, false);
  assert.equal(mismatchedRound.up.grossAvailable, false);
});

test("missing or explicitly unavailable odds suppress every probability and gross", () => {
  const missing = selectWaterxOddsDisplay({ ...activeOddsInput(), odds: null });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.up.probability, null);
  assert.equal(missing.down.grossAvailable, false);

  const unavailable = selectWaterxOddsDisplay({
    ...activeOddsInput(),
    availability: { ...activeOddsInput().availability, status: "unavailable" },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.up.probability, null);
  assert.equal(unavailable.up.grossAvailable, false);
});

test("locked and zero-cent sides never receive indicative gross", () => {
  const input = activeOddsInput();
  const selected = selectWaterxOddsDisplay({
    ...input,
    odds: { ...input.odds, upPriceCents: 0 },
    availability: {
      ...input.availability,
      status: "partial",
      up: { ...input.availability.up, side: "locked", pricePositive: false },
    },
  });
  assert.equal(selected.status, "partial");
  assert.equal(selected.up.locked, true);
  assert.equal(selected.up.probability, 0);
  assert.equal(selected.up.grossAvailable, false);
  assert.equal(selected.down.grossAvailable, true);

  const allLocked = selectWaterxOddsDisplay({
    ...input,
    odds: { ...input.odds, upPriceCents: 0, downPriceCents: 0 },
    availability: {
      status: "locked",
      up: { side: "locked", pricePositive: false },
      down: { side: "locked", pricePositive: false },
    },
  });
  assert.equal(allLocked.status, "locked");
  assert.equal(allLocked.current, false);
  assert.equal(allLocked.up.grossAvailable, false);
  assert.equal(allLocked.down.grossAvailable, false);
});

test("stale, interval-mismatched, and rolled-over round odds cannot retain old signals", () => {
  const input = activeOddsInput();
  const stale = selectWaterxOddsDisplay({ ...input, snapshotCurrent: false });
  assert.equal(stale.status, "withheld");
  assert.equal(stale.up.probability, null);

  const intervalChanged = selectWaterxOddsDisplay({ ...input, requestedInterval: 15 });
  assert.equal(intervalChanged.fresh, false);
  assert.equal(intervalChanged.down.grossAvailable, false);

  const oldRound = selectWaterxOddsDisplay({
    ...input,
    roundId: "next-round",
    roundStartMs: 9_500,
    serverNowMs: 10_000,
  });
  assert.equal(oldRound.fresh, false);
  assert.equal(oldRound.up.probability, null);
  assert.equal(oldRound.up.grossAvailable, false);

  const mismatchedIdentity = selectWaterxOddsDisplay({
    ...input,
    roundId: "next-round",
    odds: { ...input.odds, asOf: new Date(9_750).toISOString() },
  });
  assert.equal(mismatchedIdentity.status, "withheld");
  assert.equal(mismatchedIdentity.down.probability, null);
});