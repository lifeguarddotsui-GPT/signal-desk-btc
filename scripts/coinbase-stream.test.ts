import test from "node:test";
import assert from "node:assert/strict";
import { createCoinbaseStream } from "../server/btc/coinbase-stream";

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  messageData(data: unknown) { this.onmessage?.({ data }); }
}

async function flush() {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

test("non-subscribed sequence jumps do not interrupt ticker ingestion", async () => {
  let now = 1_800_000_000_000;
  const sockets: FakeSocket[] = [];
  let restReads = 0;
  const ticks: Array<{ price: number; eventId: string; source: string }> = [];
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    now: () => now,
    random: () => 0,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    readFallback: async () => {
      restReads++;
      return { price: 60_000, asOf: new Date(now).toISOString() };
    },
    onTick: tick => ticks.push(tick),
    onGap: (_at, reason) => gaps.push(reason),
  });

  feed.start();
  const activeSocket = sockets[0];
  activeSocket.onopen?.({});
  await flush();
  assert.deepEqual(JSON.parse(activeSocket.sent[0]), {
    type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "heartbeat"],
  });
  assert.equal(restReads, 1);
  assert.match(ticks[0].source, /REST fallback/);

  const ticker = (tradeId: number, sequence: number) => ({
    type: "ticker", product_id: "BTC-USD", price: "60000",
    time: new Date(now).toISOString(), trade_id: tradeId, sequence,
  });
  activeSocket.message(ticker(1, 10));
  await flush();
  activeSocket.message(ticker(1, 10));
  await flush();
  assert.equal(ticks.filter(tick => !/REST fallback/.test(tick.source)).length, 1,
    "duplicate provider identity is ignored");
  activeSocket.message({
    type: "heartbeat", product_id: "BTC-USD", sequence: 1_000, last_trade_id: 1,
  });
  activeSocket.message({
    type: "match", product_id: "BTC-USD", sequence: 2_000, trade_id: 99,
  });
  await flush();
  activeSocket.message(ticker(5, 5_000));
  activeSocket.message({
    type: "heartbeat", product_id: "BTC-USD", sequence: 9_000, last_trade_id: 5,
  });
  await flush();
  assert.equal(ticks.filter(tick => !/REST fallback/.test(tick.source)).length, 2);
  assert.equal(ticks[1].price, ticks[2].price);
  assert.notEqual(ticks[1].eventId, ticks[2].eventId);
  assert.deepEqual(gaps, []);
  assert.equal(activeSocket.closed, false);
  assert.equal(sockets.length, 1);

  feed.stop();
  assert.equal(activeSocket.closed, true);
});

test("serialized Blob decoding preserves frame order despite delayed conversion", async () => {
  let now = 1_800_000_000_000;
  let socket: FakeSocket | undefined;
  const tradeIds: string[] = [];
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    now: () => now,
    connect: () => (socket = new FakeSocket()),
    readFallback: async () => ({ price: 60_000, asOf: new Date(now).toISOString() }),
    onTick: tick => { if (!tick.source.includes("REST fallback")) tradeIds.push(tick.eventId); },
    onGap: (_at, reason) => gaps.push(reason),
  });
  feed.start();
  socket!.onopen?.({});
  await flush();
  const eventTime = new Date(now).toISOString();
  const frame = (tradeId: number, sequence: number) => JSON.stringify({
    type: "ticker", product_id: "BTC-USD", price: "60000",
    time: eventTime, trade_id: tradeId, sequence,
  });
  let releaseDecode!: (value: string) => void;
  class DelayedBlob extends Blob {
    override text() { return new Promise<string>(resolve => { releaseDecode = resolve; }); }
  }
  socket!.messageData(new DelayedBlob([frame(1, 10)]));
  socket!.messageData(frame(2, 11));
  await flush();
  assert.deepEqual(tradeIds, [], "later message must wait behind queued Blob decode");
  releaseDecode(frame(1, 10));
  await flush();

  assert.equal(JSON.stringify(tradeIds), JSON.stringify(["BTC-USD:1", "BTC-USD:2"]));
  assert.deepEqual(gaps, []);
  feed.stop();
});

test("heartbeat-confirmed ticker absence reconnects only after the grace interval", async () => {
  let now = 1_800_000_000_000;
  let socket: FakeSocket | undefined;
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    now: () => now,
    connect: () => (socket = new FakeSocket()),
    readFallback: async () => ({ price: 60_000, asOf: new Date(now).toISOString() }),
    onTick: () => {},
    onGap: (_at, reason) => gaps.push(reason),
  });
  feed.start();
  socket!.onopen?.({});
  await flush();
  socket!.message({
    type: "heartbeat", product_id: "BTC-USD", last_trade_id: 10, sequence: 10,
  });
  await flush();
  socket!.message({
    type: "ticker", product_id: "BTC-USD", price: "60000",
    time: new Date(now).toISOString(), trade_id: 10, sequence: 10,
  });
  await flush();
  socket!.message({
    type: "heartbeat", product_id: "BTC-USD", last_trade_id: 12, sequence: 11,
  });
  await flush();
  assert.equal(socket!.closed, false, "allow time for ticker batching to deliver a trade");
  now += 3_001;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.ok(gaps.some(reason => reason.includes("no matching ticker")));
  assert.equal(socket!.closed, true);
  feed.stop();
});

test("genuine sequence regression distrusts the session and emits an explicit gap", async () => {
  let now = 1_800_000_000_000;
  let socket: FakeSocket | undefined;
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    now: () => now,
    connect: () => (socket = new FakeSocket()),
    readFallback: async () => ({ price: 60_000, asOf: new Date(now).toISOString() }),
    onTick: () => {},
    onGap: (_at, reason) => gaps.push(reason),
  });
  feed.start();
  socket!.onopen?.({});
  await flush();
  const ticker = (sequence: number, tradeId: number) => ({
    type: "ticker", product_id: "BTC-USD", price: "60000",
    time: new Date(now).toISOString(), trade_id: tradeId, sequence,
  });
  socket!.message(ticker(10, 10));
  await flush();
  socket!.message(ticker(9, 11));
  await flush();
  assert.ok(gaps.some(reason => reason.includes("out of order")));
  assert.equal(socket!.closed, true);
  feed.stop();
});

test("invalid/stale events distrust and close the session; stop cancels pending reconnect", async () => {
  let now = 1_800_000_000_000;
  const sockets: FakeSocket[] = [];
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    now: () => now,
    random: () => 0,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    readFallback: async () => ({ price: 60_000, asOf: new Date(now).toISOString() }),
    onTick: () => {},
    onGap: (_at, reason) => gaps.push(reason),
  });
  feed.start();
  sockets[0].onopen?.({});
  await flush();
  sockets[0].message({
    type: "ticker", product_id: "BTC-USD", price: "60000",
    time: new Date(now - 30_000).toISOString(), trade_id: 5, sequence: 5,
  });
  await flush();
  assert.ok(gaps.some(reason => reason.includes("stale or future-dated")));
  assert.equal(sockets[0].closed, true);
  feed.stop();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(sockets.length, 1, "stop cancels reconnect timer and closes the upstream socket");
});

test("transport failures are reasoned and schedule bounded reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const gaps: string[] = [];
  const feed = createCoinbaseStream({
    random: () => 0,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    readFallback: async () => ({ price: 60_000, asOf: new Date().toISOString() }),
    onTick: () => {},
    onGap: (_at, reason) => gaps.push(reason),
  });
  feed.start();
  sockets[0].onopen?.({});
  await flush();
  sockets[0].onerror?.({});
  assert.ok(gaps.some(reason => reason.includes("transport error")));
  assert.equal(sockets[0].closed, true);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(sockets.length, 2);
  feed.stop();
});