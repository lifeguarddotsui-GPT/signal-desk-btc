import test from "node:test";
import assert from "node:assert/strict";
import {
  createVisitorActivityGate, validVisitorSessionId, VISITOR_LEASE_MS,
} from "../server/visitor-activity";

const a = "2b990314-8f16-4be4-8d7b-550a66b1e801";
const b = "2b990314-8f16-4be4-8d7b-550a66b1e802";

test("visitor activity rejects malformed and oversized sessions without waking collector", () => {
  let wakes = 0;
  const gate = createVisitorActivityGate({ wake: () => { wakes++; }, sleep: () => {} });
  assert.equal(validVisitorSessionId(a), true);
  assert.equal(gate.beat("bot"), "invalid");
  assert.equal(gate.beat("".padEnd(1000,"a")), "invalid");
  assert.equal(wakes, 0);
  assert.equal(gate.status().ready, false);
  assert.equal(gate.status().idle, true);
});

test("several visible tabs share one runtime; last leave shuts it down", () => {
  let at = 100_000, wakes = 0, stops = 0;
  const gate = createVisitorActivityGate({
    now: () => at, wake: () => { wakes++; }, sleep: () => { stops++; },
  });
  assert.equal(gate.beat(a), "accepted");
  assert.equal(gate.status().ready, false);
  gate.markReady();
  assert.equal(gate.status().ready, true);
  assert.equal(gate.beat(b), "accepted");
  assert.equal(wakes, 1);
  gate.leave(a);
  gate.reap();
  assert.equal(stops, 0, "remaining visitor retains live capture");
  gate.leave(b);
  gate.reap();
  assert.equal(stops, 1, "last visitor is gone; background stops");
  assert.equal(gate.status().ready, false);
  at += 1_000;
  assert.equal(gate.beat(a), "accepted");
  assert.equal(wakes, 2, "return visit reawakens process");
  gate.close();
  assert.equal(stops, 2);
});

test("mobile suspension expires without pagehide event; stale sessions cannot keep DB active", () => {
  let at = 100_000, stops = 0;
  const gate = createVisitorActivityGate({
    now: () => at, wake: () => {}, sleep: () => { stops++; },
  });
  gate.beat(a);
  gate.markReady();
  at += VISITOR_LEASE_MS - 1;
  gate.reap();
  assert.equal(stops, 0);
  at++;
  gate.reap();
  assert.equal(stops, 1);
  assert.equal(gate.status().activeVisitors, 0);
});

test("heartbeats renew leases without spawning duplicate DB collectors", () => {
  let at = 100_000, wakes = 0;
  const gate = createVisitorActivityGate({
    now: () => at, wake: () => { wakes++; }, sleep: () => {},
  });
  gate.beat(a);
  at += 20_000;
  gate.beat(a);
  at += 40_000;
  gate.reap();
  assert.equal(wakes, 1);
  assert.equal(gate.status().activeVisitors, 1);
  gate.close();
});

test("visitor session cap bounds malicious lease accumulation", () => {
  const gate = createVisitorActivityGate({
    now: () => 100_000, maxSessions: 1, wake: () => {}, sleep: () => {},
  });
  assert.equal(gate.beat(a), "accepted");
  assert.equal(gate.beat(b), "at-capacity");
  assert.equal(gate.beat(a), "accepted");
  gate.close();
});

test("failed collector startup cannot create an accepted visitor lease", () => {
  const gate = createVisitorActivityGate({
    wake: () => { throw new Error("external worker still enabled"); }, sleep: () => {},
  });
  assert.throws(() => gate.beat(a), /external worker/);
  assert.equal(gate.status().activeVisitors, 0);
  assert.equal(gate.status().collecting, false);
});
