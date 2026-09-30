import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWaterxRound, getCurrentWaterxRound, parseWaterxResponse, verifiedHistoricalRound, WaterxProviderError,
} from "../server/waterx/source";
import {
  buildWaterxLivePayload, isNewerWaterxObservation,
} from "../server/waterx/service";

const start = 1_800_000_000;
const marketFixture = (options: {
  interval?: 5 | 15;
  startsAt?: number;
  endsAt?: number;
  anchorPriceConfirmed?: boolean;
  anchorPrice?: number | null;
  phase?: string;
  sides?: unknown[];
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
        phase: options.phase ?? "ACTIVE",
        anchorPrice: Object.hasOwn(options, "anchorPrice") ? options.anchorPrice : 68_123.45,
        anchorPriceConfirmed: options.anchorPriceConfirmed ?? true,
        sides: options.sides ?? [
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

test("captured WaterX live response shape parses numeric-cent probabilities and lower-case phase", () => {
  // Public API response sampled 2026-09-30. Keep this reduced provider-shaped
  // fixture stable; the route values are factual public market observations.
  const captured = {
    success: true,
    data: { detail: {
      market: {
        slug: "crypto-btc-updown-5m",
        id: "9129d50d-6e9c-4c1d-b4af-a76b5993bf85",
      },
      round: {
        id: "b152223d-9b27-4a08-b3ce-b079535a0c95",
        marketId: "9129d50d-6e9c-4c1d-b4af-a76b5993bf85",
        startsAt: 1_790_742_300,
        endsAt: 1_790_742_600,
        phase: "live",
        anchorPrice: 83_339.485584398,
        anchorPriceConfirmed: false,
        sides: [
          { key: "up", oddsCents: 2.1, probabilityCents: 1.5,
            trade: { marketId: "0xb492f57338b3d93dd8f66bd980eddf2e7a83cfab01e1f4cb51b6e64c478e194f", selection: "YES" } },
          { key: "down", oddsCents: 99.1, probabilityCents: 98.5,
            trade: { marketId: "0xb492f57338b3d93dd8f66bd980eddf2e7a83cfab01e1f4cb51b6e64c478e194f", selection: "NO" } },
        ],
        indicativeOdds: false,
      },
      neighbors: { past: [], upcoming: [] },
    } },
  };
  const parsed = parseWaterxResponse(captured, 5);
  assert.equal(parsed.round.phase, "live");
  assert.equal(parsed.round.anchorPrice, 83_339.485584398);
  assert.equal(parsed.round.sides.up.probabilityCents, 1.5);
  assert.equal(parsed.round.sides.down.probabilityCents, 98.5);
  assert.equal(parsed.round.anchorPriceConfirmed, false);
});

test("missing WaterX odds remain a live round and do not suppress its reference, timer, or Coinbase comparison", () => {
  const payload = marketFixture({
    phase: "live",
    sides: [
      { key: "up", oddsCents: null, probabilityCents: null },
      { key: "down", oddsCents: 99.1, probabilityCents: 98.5 },
    ],
  });
  const detail = parseWaterxResponse(payload, 5);
  const now = (start + 120) * 1000;
  const asOf = new Date(now).toISOString();
  const live = buildWaterxLivePayload(5, {
    observedAt: asOf, status: "LIVE", round: detail.round,
    reason: "Active round", sourceError: null,
  }, now, { price: 68_100, asOf, source: "Coinbase comparison" });

  assert.equal(live.status, "LIVE");
  assert.equal(live.round?.referencePrice, 68_123.45);
  assert.equal(live.round?.expiryMs, (start + 300) * 1000);
  assert.equal(live.comparison?.price, 68_100);
  assert.equal(live.odds?.up, null);
  assert.equal(live.odds?.down, 0.985);
  assert.equal(live.availability.odds.status, "partial");
  assert.equal(live.availability.odds.reason, "WaterX side data is partial; probabilities or prices may be missing.");
  assert.equal(live.availability.odds.up.price, "unavailable");
  assert.equal(live.availability.roundMetadata.status, "available");
  assert.equal(live.availability.referencePrice.status, "available");
  assert.equal(live.availability.comparisonPrice.status, "available");
  assert.equal(live.availability.chart.status, "separate_endpoint");
  assert.equal(live.availability.model.endpoint, "/api/waterx/model");
});

test("missing or malformed side collections affect only odds availability", () => {
  const detail = parseWaterxResponse(marketFixture({ sides: [] }), 5);
  assert.equal(detail.round.id, "3c8a1377-52e4-4db5-a691-76f73c2ef237");
  assert.equal(detail.round.anchorPrice, 68_123.45);
  assert.equal(detail.round.sides.up.availability, "unavailable");
  assert.equal(detail.round.sides.down.availability, "unavailable");
  const now = (start + 120) * 1000;
  const live = buildWaterxLivePayload(5, {
    observedAt: new Date(now).toISOString(), status: "LIVE", round: detail.round,
    reason: "Active round", sourceError: null,
  }, now, null);
  assert.equal(live.status, "LIVE");
  assert.equal(live.round?.expiryMs, (start + 300) * 1000);
  assert.deepEqual(live.odds, {
    up: null, down: null, upPriceCents: null, downPriceCents: null,
    asOf: new Date(now).toISOString(),
    source: "WaterX public market probabilities and odds",
  });
  assert.equal(live.availability.odds.status, "unavailable");
  assert.equal(live.availability.odds.reason, "Odds temporarily unavailable.");
});

test("provider round metadata survives absent probabilities and zero-priced locked outcomes", () => {
  const detail = parseWaterxResponse(marketFixture({
    phase: "live",
    sides: [
      { key: "up", oddsCents: 0 },
      { key: "down", oddsCents: null, probabilityCents: null, status: "closed" },
    ],
  }), 5);
  assert.equal(detail.round.id, "3c8a1377-52e4-4db5-a691-76f73c2ef237");
  assert.equal(detail.round.startsAt, start);
  assert.equal(detail.round.endsAt, start + 300);
  assert.equal(detail.round.anchorPrice, 68_123.45);
  assert.equal(detail.round.sides.up.oddsCents, 0);
  assert.equal(detail.round.sides.up.probabilityCents, null);
  assert.equal(detail.round.sides.up.availability, "reported");
  assert.equal(detail.round.sides.down.availability, "locked");
});

test("zero probability and zero cents are values, never missing or a payout denominator", () => {
  const detail = parseWaterxResponse(marketFixture({
    sides: [
      { key: "up", oddsCents: 0, probabilityCents: 0 },
      { key: "down", oddsCents: 100, probabilityCents: 100 },
    ],
  }), 5);
  assert.equal(detail.round.sides.up.oddsCents, 0);
  assert.equal(detail.round.sides.up.probabilityCents, 0);
  assert.equal(detail.round.sides.up.availability, "reported");
  assert.equal(detail.round.sides.down.probabilityCents, 100);
  const now = (start + 120) * 1000;
  const live = buildWaterxLivePayload(5, {
    observedAt: new Date(now).toISOString(), status: "LIVE", round: detail.round,
    reason: "Active round", sourceError: null,
  }, now, null);
  assert.equal(live.odds?.up, 0);
  assert.equal(live.odds?.upPriceCents, 0);
  assert.equal(live.availability.odds.status, "available");
  assert.equal(live.availability.odds.up.price, "reported");
  assert.equal(live.availability.odds.up.pricePositive, false);
  assert.equal(live.availability.odds.up.executable, false);
  assert.equal("payout" in live.odds!, false);
});

test("locked sides and invalid probabilities are unavailable without discarding the valid side", () => {
  const detail = parseWaterxResponse(marketFixture({
    sides: [
      { key: "up", locked: true, oddsCents: null, probabilityCents: null },
      { key: "down", oddsCents: 99, probabilityCents: 101 },
    ],
  }), 5);
  assert.equal(detail.round.sides.up.availability, "locked");
  assert.equal(detail.round.sides.up.probabilityCents, null);
  assert.equal(detail.round.sides.down.oddsCents, 99);
  assert.equal(detail.round.sides.down.probabilityCents, null);
  assert.match(detail.round.sides.down.reason ?? "", /within \[0,100\]/);
});

test("a provider round with unavailable reference metadata stays identifiable but cannot claim confirmation", () => {
  const detail = parseWaterxResponse(marketFixture({
    anchorPrice: null, anchorPriceConfirmed: true,
  }), 5);
  assert.equal(detail.round.anchorPrice, null);
  assert.equal(detail.round.anchorPriceConfirmed, false);
  assert.match(detail.round.referenceUnavailableReason ?? "", /missing or invalid/);
  assert.equal(classifyWaterxRound(detail, 5, (start + 100) * 1000).status, "LIVE");
});

test("only a round active at server time is current; stale and future rounds are not live", () => {
  const detail = parseWaterxResponse(marketFixture(), 5);
  assert.equal(classifyWaterxRound(detail, 5, start * 1000).status, "LIVE");
  assert.equal(classifyWaterxRound(detail, 5, (start + 300) * 1000).status, "STALE");
  assert.equal(classifyWaterxRound(detail, 5, (start - 1) * 1000).status, "NO_ACTIVE_ROUND");
});

test("a delayed round response cannot restore expired odds or replace an equal-time round identity", () => {
  const detail = parseWaterxResponse(marketFixture({ phase: "live" }), 5);
  const now = (start + 301) * 1000;
  const asOf = new Date(now).toISOString();
  const expired = buildWaterxLivePayload(5, {
    observedAt: asOf, status: "LIVE", round: detail.round,
    reason: "Active round", sourceError: null,
  }, now, { price: 68_100, asOf, source: "Coinbase comparison" });
  assert.equal(expired.status, "STALE");
  assert.equal(expired.round, null);
  assert.equal(expired.odds, null);
  assert.equal(expired.comparison?.price, 68_100);
  assert.match(expired.reason, /expired/);

  const prior = { round: { id: detail.round.id, startsAt: detail.round.startsAt } };
  assert.equal(isNewerWaterxObservation(prior, {
    id: detail.round.id, startsAt: detail.round.startsAt,
  }), true);
  assert.equal(isNewerWaterxObservation(prior, {
    id: "e92e2a42-341e-4be1-946d-d2fbfe465312", startsAt: detail.round.startsAt,
  }), false);
  assert.equal(isNewerWaterxObservation(prior, {
    id: "e92e2a42-341e-4be1-946d-d2fbfe465312", startsAt: detail.round.startsAt + 300,
  }), true);
  assert.equal(isNewerWaterxObservation(prior, {
    id: "e92e2a42-341e-4be1-946d-d2fbfe465312", startsAt: detail.round.startsAt - 300,
  }), false);
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

test("current-round cache identity changes at the interval boundary", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = (start + 899) * 1000;
  let fetches = 0;
  let releaseOld!: (response: Response) => void;
  let releaseNew!: (response: Response) => void;
  Date.now = () => now;
  globalThis.fetch = () => {
    fetches += 1;
    return new Promise(resolve => {
      if (fetches === 1) releaseOld = resolve;
      else releaseNew = resolve;
    });
  };
  try {
    const oldRead = getCurrentWaterxRound(15, now);
    await Promise.resolve();
    assert.equal(fetches, 1);

    now = (start + 900) * 1000;
    const newRead = getCurrentWaterxRound(15, now);
    await Promise.resolve();
    assert.equal(fetches, 2);
    const responseFor = (roundStart: number) => new Response(JSON.stringify(marketFixture({
      interval: 15, startsAt: roundStart, endsAt: roundStart + 900,
    })), { status: 200, headers: { "content-type": "application/json" } });
    releaseNew(responseFor(start + 900));
    const after = await newRead;
    assert.equal(after.status, "LIVE");
    assert.equal(after.detail.round.startsAt, start + 900);
    releaseOld(responseFor(start));
    const before = await oldRead;
    assert.equal(before.status, "LIVE");
    assert.equal(before.detail.round.startsAt, start);

    const cached = await getCurrentWaterxRound(15, now);
    assert.equal(cached.detail.round.startsAt, start + 900);
    assert.equal(fetches, 2);
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
