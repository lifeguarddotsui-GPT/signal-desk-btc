import test from "node:test";
import assert from "node:assert/strict";
import { getCurrentWaterxRound } from "../server/waterx/source";
import { startWaterxCapture } from "../server/waterx/service";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const start = 1_800_000_000;

function liveResponse() {
  return new Response(JSON.stringify({
    success: true,
    data: { detail: {
      market: { slug: "crypto-btc-updown-5m", marketId: "btc-5m" },
      round: {
        id: "3c8a1377-52e4-4db5-a691-76f73c2ef237", marketId: "btc-5m",
        startsAt: start, endsAt: start + 300, phase: "ACTIVE",
        anchorPrice: 68_123, anchorPriceConfirmed: true,
        sides: [
          { key: "up", oddsCents: 51, probabilityCents: 52 },
          { key: "down", oddsCents: 49, probabilityCents: 48 },
        ],
      },
      neighbors: { past: [], upcoming: [] },
    } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("aborted source read releases coalescing and a late response cannot poison retry cache", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = (start + 100) * 1000;
  let fetches = 0;
  let releaseLate!: (response: Response) => void;
  Date.now = () => now;
  globalThis.fetch = () => {
    fetches += 1;
    return fetches === 1
      ? new Promise<Response>(resolve => { releaseLate = resolve; })
      : Promise.resolve(liveResponse());
  };
  const controller = new AbortController();
  try {
    const abandoned = getCurrentWaterxRound(5, now, {
      signal: controller.signal, timeoutMs: 1_000,
    });
    await Promise.resolve();
    assert.equal(fetches, 1);
    controller.abort();
    await assert.rejects(abandoned, /cancelled/);

    // Complete the old fetch after cancellation. It may finish transport work,
    // but it must not cache or become the result of the next accepted read.
    releaseLate(liveResponse());
    await Promise.resolve();
    const recovered = await getCurrentWaterxRound(5, now, { timeoutMs: 50 });
    assert.equal(recovered.status, "LIVE");
    assert.equal(recovered.sourceTimestamp, null, "the provider does not supply a trusted source timestamp");
    assert.ok(Number.isFinite(Date.parse(recovered.requestReceivedAt)));
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("source timeout covers a response body that never completes", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const now = (start + 100) * 1000;
  let fetches = 0;
  let bodyCancelled = false;
  Date.now = () => now;
  globalThis.fetch = () => {
    fetches += 1;
    if (fetches === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
        cancel() { bodyCancelled = true; },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    const payload = {
      success: true,
      data: { detail: {
        market: { slug: "crypto-btc-updown-15m", marketId: "btc-15m" },
        round: {
          id: "3c8a1377-52e4-4db5-a691-76f73c2ef238", marketId: "btc-15m",
          startsAt: start, endsAt: start + 900, phase: "ACTIVE",
          anchorPrice: 68_123, anchorPriceConfirmed: true,
          sides: [
            { key: "up", oddsCents: 51, probabilityCents: 52 },
            { key: "down", oddsCents: 49, probabilityCents: 48 },
          ],
        },
        neighbors: { past: [], upcoming: [] },
      } },
    };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  };
  try {
    const bodyRead = getCurrentWaterxRound(15, now, { timeoutMs: 20 });
    const rejection = assert.rejects(bodyRead, /cancelled|timed out/);
    // Node's AbortSignal.timeout timer is intentionally unreferenced; keep this
    // standalone test process alive until the bounded read rejects.
    await wait(30);
    await rejection;
    assert.equal(bodyCancelled, true, "abort must cancel the unread response stream");
    assert.equal((await getCurrentWaterxRound(15, now, { timeoutMs: 50 })).status, "LIVE");
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("a timed-out collector read is released and the interval retries after backoff", async () => {
  let fiveMinuteAttempts = 0;
  let activeFiveMinuteReads = 0;
  let maximumActiveFiveMinuteReads = 0;
  const stop = startWaterxCapture({
    readTimeoutMs: 20,
    retryDelayMs: 10,
    periods: { 5: 5, 15: 5 },
    watchdogPeriodMs: 1_000,
    poll: (interval, signal) => {
      if (interval !== 5) return Promise.resolve();
      fiveMinuteAttempts += 1;
      activeFiveMinuteReads += 1;
      maximumActiveFiveMinuteReads = Math.max(maximumActiveFiveMinuteReads, activeFiveMinuteReads);
      if (fiveMinuteAttempts > 1) {
        activeFiveMinuteReads -= 1;
        return Promise.resolve();
      }
      // This simulated source honors cancellation and releases its operation.
      return new Promise<void>(resolve => {
        signal.addEventListener("abort", () => {
          activeFiveMinuteReads -= 1;
          resolve();
        }, { once: true });
      });
    },
  });
  try {
    await wait(150);
    assert.ok(fiveMinuteAttempts >= 2, "the failed read must not pin the next scheduled poll");
    assert.equal(maximumActiveFiveMinuteReads, 1, "one accepted read per interval at a time");
  } finally {
    stop();
  }
});