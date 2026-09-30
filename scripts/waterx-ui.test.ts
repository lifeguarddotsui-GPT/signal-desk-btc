import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveWaterxRound,
  isCoinbaseSource,
  isFreshWaterxSnapshot,
  insertTimestampGaps,
  isWaterxMarketSource,
  mergePricePoints,
  indicativeGross,
  resetSseCursor,
  sseReconnectUrl,
  stablePricePointKey,
  SETTLEMENT_SOURCE_LABEL,
  WATERX_REFERENCE_LABEL,
} from "../client/src/waterx-ui-contract";

test("SSE restart replaces an old cursor, including the valid reset ID zero", () => {
  assert.equal(sseReconnectUrl("/api/chart/stream", resetSseCursor("0")),
    "/api/chart/stream?lastEventId=0");
  assert.equal(resetSseCursor(""), "");
  assert.equal(resetSseCursor("not-an-id"), "");
});

test("Price to beat is named as WaterX's beginning reference, not Chainlink's settlement TWAP", () => {
  assert.match(WATERX_REFERENCE_LABEL, /WATERX.*BEGINNING REFERENCE/);
  assert.doesNotMatch(WATERX_REFERENCE_LABEL, /CHAINLINK/i);
  assert.match(SETTLEMENT_SOURCE_LABEL, /CHAINLINK BTC\/USD TWAP.*SETTLEMENT/);
});

test("active round guard requires the selected 5m or 15m interval and an unexpired round", () => {
  assert.equal(isActiveWaterxRound(5, 5, 1_000, 301_000, 90_000), true);
  assert.equal(isActiveWaterxRound(15, 15, 1_000, 901_000, 90_000), true);
  assert.equal(isActiveWaterxRound(5, 15, 1_000, 901_000, 90_000), false);
  assert.equal(isActiveWaterxRound("5", 5, 1_000, 301_000, 90_000), false);
  assert.equal(isActiveWaterxRound(5, 5, 1_000, 301_000, 301_000), false);
  assert.equal(isActiveWaterxRound(5, 5, 1_000, 301_000, 999), false);
});

test("live snapshot freshness uses the selected market's 16s or 31s tolerance and rejects stale server payloads", () => {
  const now = 100_000;
  assert.equal(isFreshWaterxSnapshot(84_000, new Date(84_000).toISOString(), now, 16_000), true);
  assert.equal(isFreshWaterxSnapshot(83_999, new Date(83_999).toISOString(), now, 16_000), false);
  assert.equal(isFreshWaterxSnapshot(69_000, new Date(69_000).toISOString(), now, 31_000), true);
  assert.equal(isFreshWaterxSnapshot(68_999, new Date(68_999).toISOString(), now, 31_000), false);
  assert.equal(isFreshWaterxSnapshot(99_000, new Date(60_000).toISOString(), now, 31_000), false);
  assert.equal(isFreshWaterxSnapshot(99_000, null, now, 31_000), false);
});

test("chart path inserts a visible break for timestamp outages beyond the feed tolerance", () => {
  const uninterrupted = insertTimestampGaps([
    { at: 10_000, price: 100 },
    { at: 24_000, price: 101 },
  ], 14_000);
  assert.equal(uninterrupted.length, 2);
  const interrupted = insertTimestampGaps([
    { at: 10_000, price: 100 },
    { at: 24_001, price: 101 },
  ], 14_000);
  assert.equal(interrupted.length, 3);
  assert.equal(interrupted[1].gap, true);
  assert.equal(interrupted[1].price, null);
  assert.match(interrupted[1].reason ?? "", /timestamp separation/i);
});

test("comparison and market prices keep their sources distinct", () => {
  assert.equal(isCoinbaseSource("Coinbase Advanced Trade"), true);
  assert.equal(isCoinbaseSource("Chainlink BTC/USD"), false);
  assert.equal(isWaterxMarketSource("WaterX market"), true);
  assert.equal(isWaterxMarketSource("Coinbase live"), false);
});

test("archive and stream merge by stable observed timestamp and price identity", () => {
  const archived = { at: 1_000, price: 83_500, source: "Coinbase archive" };
  const streamed = { at: 1_000, price: 83_500, source: "Coinbase live" };
  assert.equal(stablePricePointKey(archived), stablePricePointKey(streamed));
  const merged = mergePricePoints([archived], [streamed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "Coinbase live");
  assert.equal(mergePricePoints([{ at: 1_001, price: null, gap: true }], [{ at: 1_001, price: 83_500 }]).length, 2);
});

test("SSE manual reconnect keeps the replay cursor encoded and does not alter a cursorless endpoint", () => {
  assert.equal(sseReconnectUrl("/api/chart/stream", ""), "/api/chart/stream");
  assert.equal(sseReconnectUrl("/api/chart/stream", "42"), "/api/chart/stream?lastEventId=42");
  assert.equal(sseReconnectUrl("/events?kind=tick", "a b"), "/events?kind=tick&lastEventId=a%20b");
});

test("one-sided indicative gross uses selected amount and WaterX side price without claiming net profit", () => {
  assert.equal(indicativeGross(5, 25), 20);
  assert.equal(indicativeGross(5, 87.8), 5 / 0.878);
  assert.equal(indicativeGross(0, 25), null);
  assert.equal(indicativeGross(5, 0), null);
  assert.equal(indicativeGross(5, 101), null);
});