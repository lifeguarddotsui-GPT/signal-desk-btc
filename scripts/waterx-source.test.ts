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
      neighbors: { past: [], upcoming: [] },
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
