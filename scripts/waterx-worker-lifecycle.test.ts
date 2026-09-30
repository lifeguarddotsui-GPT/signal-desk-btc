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
    candidateEvaluationEnabled: false,
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
      candidateEvaluationEnabled: false,
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
    candidateEvaluationEnabled: false,
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
      candidateEvaluationEnabled: false,
    }),
    /requires learning and comparison tick migrations/,
  );
  assert.equal(db.queries.length, 1);
  assert.equal(db.endCalls, 1);
});

test("development candidate schedule starts only after lease acquisition and is stopped with worker", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const db = fakeDatabase([
      { rows: [{ learning: "waterx_learning_rounds", ticks: "waterx_comparison_ticks" }] },
      { rows: [{ acquired: true }] },
      { rows: [{ lease_owned: true }] },
    ]);
    const events: string[] = [];
    let scheduled: (() => void) | undefined;
    const worker = await startWaterxWorker(db, {
      startPriceCapture: () => () => {},
      startWaterxCapture: () => () => {},
      candidateScheduleIntervalMs: 24 * 60 * 60_000,
      runCandidateEvaluation: async () => { events.push("evaluate"); },
      setInterval: ((callback: () => void) => {
        scheduled = callback;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => { events.push("timer-stop"); }) as typeof clearInterval,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["evaluate"]);
    assert.ok(scheduled);
    await worker.stop();
    assert.deepEqual(events, ["evaluate", "timer-stop", "timer-stop"]);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("candidate evaluation is not activated in production even when a runner is available", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const db = fakeDatabase([
      { rows: [{ learning: "waterx_learning_rounds", ticks: "waterx_comparison_ticks" }] },
      { rows: [{ acquired: true }] },
    ]);
    let evaluationCount = 0;
    const worker = await startWaterxWorker(db, {
      startPriceCapture: () => () => {},
      startWaterxCapture: () => () => {},
      candidateEvaluationEnabled: true,
      runCandidateEvaluation: async () => { evaluationCount++; },
    });
    await new Promise(resolve => setImmediate(resolve));
    await worker.stop();
    assert.equal(evaluationCount, 0);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});