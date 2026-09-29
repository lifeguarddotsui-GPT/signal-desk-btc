import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptComparisonTick,
  latestChartEventId,
  subscribeChartEvents,
} from "../server/btc/chart";

test("accepted comparison ticks flow through chart capture to shared subscribers", () => {
  const events: Array<{ id: number; type: string; data: Record<string, unknown> }> = [];
  const unsubscribe = subscribeChartEvents(event => events.push(event as typeof events[number]));
  const startId = latestChartEventId();
  const asOf = new Date().toISOString();

  assert.equal(acceptComparisonTick({
    price: 60_000, asOf, eventId: `integration:${startId}:1`,
  }), true);
  assert.equal(acceptComparisonTick({
    price: 60_001, asOf: new Date(Date.parse(asOf) + 1).toISOString(),
    eventId: `integration:${startId}:2`,
  }), true);

  unsubscribe();
  assert.deepEqual(events.map(event => event.type), ["tick", "tick"]);
  assert.equal(events[0].data.price, 60_000);
  assert.equal(events[1].data.price, 60_001);
  assert.equal(events[1].id, events[0].id + 1);
});