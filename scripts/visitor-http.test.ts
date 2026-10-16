import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerVisitorPresence } from "../server/visitor-routes";
import { createVisitorActivityGate } from "../server/visitor-activity";

const id = "2b990314-8f16-4be4-8d7b-550a66b1e801";

test("only a visible visitor heartbeat can activate data API; passive health never wakes database", async () => {
  let wakes = 0, stops = 0;
  const gate = createVisitorActivityGate({
    wake: () => { wakes++; },
    sleep: () => { stops++; },
  });
  const app = express();
  app.use(express.json());
  registerVisitorPresence(app, gate);
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/check", (_req, res) => res.json({ status: "ok" }));
  const server = app.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP server unavailable");
  const base = "http://127.0.0.1:" + address.port;
  const request = (route: string, method = "GET", body?: unknown) =>
    fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json", Origin: base } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await request("/health/live")).status, 200);
    assert.equal((await request("/api/waterx/live?interval=5")).status, 503);
    assert.equal(wakes, 0);
    assert.deepEqual(await (await request("/api/visitor/status")).json(), {
      mode: "visitor-only", activeVisitors: 0, collecting: false, ready: false, idle: true,
    });
    assert.equal((await request("/api/visitor/heartbeat", "POST", {sessionId: "malformed"})).status, 400);
    assert.equal(wakes, 0);
    let heartbeat = await request("/api/visitor/heartbeat", "POST", {sessionId: id});
    assert.equal(heartbeat.status, 200);
    assert.equal((await heartbeat.json() as {ready:boolean}).ready, false,
      "a heartbeat does not bypass database readiness");
    assert.equal(wakes, 1);
    assert.equal((await request("/api/check")).status, 503);
    gate.markReady();
    heartbeat = await request("/api/visitor/heartbeat", "POST", {sessionId: id});
    assert.equal((await heartbeat.json() as {ready:boolean}).ready, true);
    assert.equal((await request("/api/check")).status, 200);
    assert.equal((await request("/api/visitor/leave", "POST", {sessionId: id})).status, 204);
    gate.reap();
    assert.equal(stops, 1);
    assert.equal((await request("/api/check")).status, 503);
    assert.equal((await request("/health/live")).status, 200);
    assert.equal(wakes, 1);
  } finally {
    gate.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
