import test from "node:test";
import assert from "node:assert/strict";
import { createEconomicsFeed } from "../server/btc/economics-feed";
import type { RoundEconomics } from "../server/btc/economics";

const market = { marketId: "0x" + "1".repeat(64), expiryMs: 100_000 };
const valid = (marketId: string, expiryMs: number, at: number): RoundEconomics => ({
  status: "AVAILABLE", marketId, expiryMs, asOf: new Date(at).toISOString(), ageMs: 0,
  sizing: { mode: "PAYOUT_QUANTITY", requestedPayoutQuantity: 5, totalSpendBudget: null, note: "" },
  referencePrice: 80_000, referenceAsOf: new Date(at).toISOString(), oracleSourceTimes: null,
  assumptions: [], up: {} as RoundEconomics["up"], down: {} as RoundEconomics["down"],
  upError: null, downError: null, reason: null, technicalDetail: null,
});

test("concurrent requests share one read and cache only their own live round", async () => {
  let now = 50_000, calls = 0;
  const feed = createEconomicsFeed(async input => {
    calls++;
    return valid(input.marketId, input.expiryMs, now);
  }, () => now);
  const [a, b] = await Promise.all([feed.get(market), feed.get(market)]);
  assert.equal(a.status, "AVAILABLE");
  assert.equal(b.status, "AVAILABLE");
  assert.equal(calls, 1);
  await feed.get(market);
  assert.equal(calls, 1);
  await feed.get({ marketId: "0x" + "2".repeat(64), expiryMs: 110_000 });
  assert.equal(calls, 2);
});

test("stale quotes and the closed manual window never expose old costs", async () => {
  let now = 50_000;
  const feed = createEconomicsFeed(async input =>
    valid(input.marketId, input.expiryMs, 20_000), () => now);
  const stale = await feed.get(market);
  assert.equal(stale.status, "STALE_QUOTE");
  assert.equal(stale.up, null);
  now = 82_000;
  const late = await feed.get(market);
  assert.equal(late.status, "TOO_LATE");
  assert.equal(late.down, null);
  now = 100_000;
  assert.equal((await feed.get(market)).status, "EXPIRED");
});

test("invalid requests and future/stale timestamps fail closed without serving the old round", async () => {
  let now = 50_000, calls = 0;
  const feed = createEconomicsFeed(async input => {
    calls++;
    return valid(input.marketId, input.expiryMs, now + 1);
  }, () => now);
  assert.equal((await feed.get({ marketId: "not-a-chain-id", expiryMs: 100_000 })).status, "INVALID_REQUEST");
  assert.equal(calls, 0);
  const future = await feed.get(market);
  assert.equal(future.status, "STALE_QUOTE");
  assert.equal(future.up, null);
  now = 51_000;
  const nextRound = await feed.get({ marketId: "0x" + "2".repeat(64), expiryMs: 110_000 });
  assert.equal(nextRound.marketId, "0x" + "2".repeat(64));
  assert.equal(calls, 2);
});

test("provider exceptions have a short safe reason and separate technical detail", async () => {
  const feed = createEconomicsFeed(async () => {
    throw new Error("private low-level transport diagnostic");
  }, () => 50_000);
  const result = await feed.get(market);
  assert.equal(result.status, "PROVIDER_ERROR");
  assert.equal(result.reason, "Anonymous quote service is temporarily unavailable; try again shortly.");
  assert.match(result.technicalDetail ?? "", /private low-level/);
  assert.doesNotMatch(result.reason ?? "", /private low-level/);
});