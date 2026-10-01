import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, startStoreInitializationRecovery } from "../server/index";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("store initialization retries failures and reports readiness once on recovery", async () => {
  let attempts = 0;
  let readyCalls = 0;
  const recovered = new Promise<void>(resolve => {
    const stop = startStoreInitializationRecovery(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated database outage");
      },
      () => {
        readyCalls += 1;
        stop();
        resolve();
      },
      { initialDelayMs: 5, maxDelayMs: 5, onFailure: () => {} },
    );
  });

  await recovered;
  assert.equal(attempts, 2);
  assert.equal(readyCalls, 1);
});

test("a stalled database initialization does not block homepage or liveness", async () => {
  const stopInitialization = startStoreInitializationRecovery(
    () => new Promise<void>(() => {}),
    () => assert.fail("stalled initialization must not be declared ready"),
  );
  const app = createApp();
  // The production static middleware is mounted after the shared API routes.
  app.get("/", (_req, res) => res.status(200).type("html").send("<main>Signal Desk</main>"));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const homepage = await fetch(baseUrl);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Signal Desk/);

    const liveness = await fetch(`${baseUrl}/health/live`);
    assert.equal(liveness.status, 200);
    assert.deepEqual(await liveness.json(), { status: "ok", readOnly: true });
    await wait(10);
  } finally {
    stopInitialization();
    await new Promise<void>((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve()));
  }
});