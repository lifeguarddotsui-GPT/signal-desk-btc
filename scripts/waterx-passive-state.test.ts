import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/index";
import { getWaterxDiagnostics } from "../server/waterx/service";

test("passive per-interval diagnostics do not trigger provider reads; non-$5 budgets return 400", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const interval of [5, 15] as const) {
      const before = getWaterxDiagnostics(interval).requestAttempt;
      const response = await fetch(`${base}/api/waterx/collector-state?interval=${interval}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.intervalMinutes, interval);
      assert.equal(body.readBehavior, "passive-no-provider-refresh-no-database-query");
      assert.equal(getWaterxDiagnostics(interval).requestAttempt, before);
    }
    const invalid = await fetch(`${base}/api/waterx/advisory?interval=5&amount=10`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /exactly \$5/);
    assert.equal((await fetch(`${base}/api/waterx/collector-state?interval=1`)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});