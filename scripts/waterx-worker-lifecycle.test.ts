import assert from "node:assert/strict";
import test from "node:test";
import { startWaterxWorker } from "../server/waterx/worker";

function fakeDatabase(results: Array<{ rows: unknown[] }>) {
  const queries: string[] = [];
  let endCalls = 0;
  return {
    queries,
    get endCalls() { return endCalls; },
    query: async (sql: string) => {
      queries.push(sql);
      const result = results.shift();
      if (!result) throw new Error("Unexpected database query");
      return result;
    },
    end: async () => { endCalls++; },
  };
}

test("worker acquires the advisory lease before starting capture and stops idempotently", async () => {
  const db = fakeDatabase([
    { rows: [{ learning: "waterx_learning_rounds", ticks: "waterx_comparison_ticks" }] },
    { rows: [{ acquired: true }] },
  ]);
  const events: string[] = [];
  let heartbeat: (() => void) | undefined;
  const worker = await startWaterxWorker(db, {
    startPriceCapture: () => { events.push("price-start"); return () => events.push("price-stop"); },
    startWaterxCapture: () => { events.push("waterx-start"); return () => events.push("waterx-stop"); },
    setInterval: ((callback: () => void) => {
      heartbeat = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => { events.push("heartbeat-stop"); }) as typeof clearInterval,
  });

  assert.match(db.queries[1], /pg_try_advisory_lock/);
  assert.deepEqual(events, ["price-start", "waterx-start"]);
  await worker.stop();
  await worker.stop();
  assert.deepEqual(events, [
    "price-start", "waterx-start", "heartbeat-stop", "waterx-stop", "price-stop",
  ]);
  assert.equal(db.endCalls, 1);
  assert.ok(heartbeat);
});

test("worker refuses an occupied advisory lease without starting collectors", async () => {
  const db = fakeDatabase([
    { rows: [{ learning: "waterx_learning_rounds", ticks: "waterx_comparison_ticks" }] },
    { rows: [{ acquired: false }] },
  ]);
  let started = false;
  await assert.rejects(
    startWaterxWorker(db, {
      startPriceCapture: () => { started = true; return () => {}; },
      startWaterxCapture: () => { started = true; return () => {}; },
    }),
    /Another WaterX collector worker holds the database lease/,
  );
  assert.equal(started, false);
  assert.equal(db.endCalls, 1);
});

test("lost database lease stops both captures and reports a fatal lifecycle failure", async () => {
  const db = fakeDatabase([
    { rows: [{ learning: "waterx_learning_rounds", ticks: "waterx_comparison_ticks" }] },
    { rows: [{ acquired: true }] },
  ]);
  let heartbeat: (() => void) | undefined;
  const stopped: string[] = [];
  let fatal: unknown;
  const worker = await startWaterxWorker(db, {
    startPriceCapture: () => () => stopped.push("price"),
    startWaterxCapture: () => () => stopped.push("waterx"),
    setInterval: ((callback: () => void) => {
      heartbeat = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
    onLeaseLost: error => { fatal = error; },
  });
  db.query = async () => { throw new Error("database connection lost"); };
  heartbeat!();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(stopped, ["waterx", "price"]);
  assert.match(String(fatal), /database connection lost/);
  assert.equal(db.endCalls, 1);
});

test("worker refuses to start when required WaterX migrations are absent", async () => {
  const db = fakeDatabase([{ rows: [{ learning: null, ticks: null }] }]);
  await assert.rejects(
    startWaterxWorker(db, {
      startPriceCapture: () => () => {},
      startWaterxCapture: () => () => {},
    }),
    /requires learning and comparison tick migrations/,
  );
  assert.equal(db.queries.length, 1);
  assert.equal(db.endCalls, 1);
});