import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWaterxRound, parseWaterxResponse, verifiedHistoricalRound, WaterxProviderError,
} from "../server/waterx/source";

const start = 1_800_000_000;
const marketFixture = (options: {
  interval?: 5 | 15;
  startsAt?: number;
  endsAt?: number;
  anchorPriceConfirmed?: boolean;
  settlement?: unknown;
  settlePrice?: number | null;
  resolutionStatus?: string | null;
  outcome?: string | null;
  past?: unknown[];
  upcoming?: unknown[];
} = {}) => {
  const interval = options.interval ?? 5;
  const startsAt = options.startsAt ?? start;
  const endsAt = options.endsAt ?? startsAt + interval * 60;
  return {
    success: true,
    data: { detail: {
      market: { slug: `crypto-btc-updown-${interval}m`, marketId: `btc-${interval}m` },
      round: {
        id: "3c8a1377-52e4-4db5-a691-76f73c2ef237",
        marketId: `btc-${interval}m`,
        startsAt,
        endsAt,
        phase: "ACTIVE",
        anchorPrice: 68_123.45,
        anchorPriceConfirmed: options.anchorPriceConfirmed ?? true,
        sides: [
          { key: "up", oddsCents: 51, probabilityCents: 52 },
          { key: "down", oddsCents: 49, probabilityCents: 48 },
        ],
        settlement: options.settlement ?? (options.outcome === undefined ? null : {
          outcome: options.outcome, settledAt: endsAt + 4,
        }),
        settlePrice: options.settlePrice ?? null,
        resolutionStatus: options.resolutionStatus ?? null,
      },
      neighbors: { past: options.past ?? [], upcoming: options.upcoming ?? [] },
    } },
  };
};

test("WaterX parser validates the public envelope, market slug, marketId, round UUID, and exact cadence", () => {
  const parsed = parseWaterxResponse(marketFixture(), 5);
  assert.equal(parsed.market.slug, "crypto-btc-updown-5m");
  assert.equal(parsed.market.marketId, "btc-5m");
  assert.equal(parsed.round.id, "3c8a1377-52e4-4db5-a691-76f73c2ef237");
  assert.throws(() => parseWaterxResponse(marketFixture({ endsAt: start + 301 }), 5), WaterxProviderError);
  assert.throws(() => parseWaterxResponse(marketFixture({ interval: 15 }), 5), /slug mismatch/);
  const invalidMarket = marketFixture() as { data: { detail: { market: { marketId: string } } } };
  invalidMarket.data.detail.market.marketId = "../wrong";
  assert.throws(() => parseWaterxResponse(invalidMarket, 5), /marketId/);
});

test("only a round active at server time is current; stale and future rounds are not live", () => {
  const detail = parseWaterxResponse(marketFixture(), 5);
  assert.equal(classifyWaterxRound(detail, 5, start * 1000).status, "LIVE");
  assert.equal(classifyWaterxRound(detail, 5, (start + 300) * 1000).status, "STALE");
  assert.equal(classifyWaterxRound(detail, 5, (start - 1) * 1000).status, "NO_ACTIVE_ROUND");
});

test("active-round discovery prefers a validated active neighbor over a future preview", () => {
  const active = marketFixture({
    startsAt: start,
    endsAt: start + 300,
  }).data.detail.round;
  const future = marketFixture({
    startsAt: start + 300,
    endsAt: start + 600,
  });
  future.data.detail.neighbors.past = [];
  future.data.detail.neighbors.upcoming = [active];
  const detail = parseWaterxResponse(future, 5);
  const result = classifyWaterxRound(detail, 5, (start + 150) * 1000);
  assert.equal(result.status, "LIVE");
  assert.equal(result.detail.round.startsAt, start);
  assert.equal(result.detail.round.id, active.id);
});

test("strict interval validation rejects unsupported runtime values", () => {
  assert.throws(() => parseWaterxResponse(marketFixture(), 10 as 5), /interval must be 5 or 15/);
  assert.throws(() => classifyWaterxRound(
    parseWaterxResponse(marketFixture(), 5), 10 as 5, start * 1000,
  ), /interval must be 5 or 15/);
});

test("fractional provider timestamps are rejected before they can reach observation or settlement storage", () => {
  assert.throws(() => parseWaterxResponse(marketFixture({ startsAt: start + 0.25 }), 5), /startsAt/);
  assert.throws(() => parseWaterxResponse(marketFixture({
    settlement: { outcome: "UP", settledAt: start + 304.5 },
  }), 5), /settledAt/);
});

test("round rollover classifies the prior observation stale and the new round live", () => {
  const previous = parseWaterxResponse(marketFixture(), 5);
  const next = parseWaterxResponse(marketFixture({
    startsAt: start + 300,
    endsAt: start + 600,
  }), 5);
  assert.equal(classifyWaterxRound(previous, 5, (start + 300) * 1000).status, "STALE");
  assert.equal(classifyWaterxRound(next, 5, (start + 300) * 1000).status, "LIVE");
});

test("concurrent stale live reads share one bounded WaterX refresh", async () => {
  const intervalStart = Math.floor(Date.now() / 300_000) * 300;
  const testNow = (intervalStart + 1) * 1000;
  const payload = marketFixture({
    startsAt: intervalStart,
    endsAt: intervalStart + 300,
  });
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let fetches = 0;
  Date.now = () => testNow;
  globalThis.fetch = async (request) => {
    // Reconciliation may independently fetch historical pending rounds from
    // the development database. Count only the coalesced current-round read.
    if (!new URL(String(request)).searchParams.has("epoch")) fetches += 1;
    await new Promise(resolve => setTimeout(resolve, 25));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { getLiveWaterx, getWaterxDiagnostics } = await import("../server/waterx/service");
    const [first, second] = await Promise.all([getLiveWaterx(5), getLiveWaterx(5)]);
    assert.equal(fetches, 1);
    assert.equal(first.status, "LIVE");
    assert.equal(second.status, "LIVE");
    const health = getWaterxDiagnostics(5);
    assert.ok(health.lastFetchAttemptAt);
    assert.ok(health.lastFetchSuccessAt);
    assert.ok(health.lastValidObservationAt);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("WaterX anchor is retained even when provider marks it unconfirmed", () => {
  const detail = parseWaterxResponse(marketFixture({ anchorPriceConfirmed: false }), 5);
  assert.equal(detail.round.anchorPrice, 68_123.45);
  assert.equal(detail.round.anchorPriceConfirmed, false);
});

test("historical settlement must match the observed ID and closing epoch, not the opening epoch", () => {
  const detail = parseWaterxResponse(marketFixture(), 5);
  assert.equal(verifiedHistoricalRound(detail, detail.round.id, start + 300).id, detail.round.id);
  assert.throws(() => verifiedHistoricalRound(detail, detail.round.id, start), /closing boundary/);
  assert.throws(() => verifiedHistoricalRound(detail,
    "00000000-0000-4000-8000-000000000000", start + 300), /identity/);
});

test("settlement outcome is only the provider label; no outcome is inferred from settlePrice", () => {
  const unresolved = parseWaterxResponse(marketFixture({
    settlePrice: 69_000, resolutionStatus: "PENDING",
  }), 5).round;
  assert.equal(unresolved.settlePrice, 69_000);
  assert.equal(unresolved.settlement, null);

  const resolved = parseWaterxResponse(marketFixture({
    outcome: "UP", settlePrice: 69_000, resolutionStatus: "RESOLVED",
  }), 5).round;
  assert.equal(resolved.settlement?.outcome, "UP");
  assert.equal(resolved.settlement?.settledAt, start + 304);
  assert.equal(resolved.resolutionStatus, "RESOLVED");
});
