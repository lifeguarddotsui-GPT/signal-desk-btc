import assert from "node:assert/strict";
import test from "node:test";
import { reportDelayMs } from "./cloudflare-waterx-report-watch.mjs";

test("report waits until 4:03 p.m. Belize, not the earlier 24h boundary", () => {
  const after = Date.parse("2026-10-01T22:03:00.000Z");
  assert.equal(reportDelayMs(after - 1), 1);
  assert.equal(reportDelayMs(Date.parse("2026-10-01T22:02:44.752Z")), 15_248);
  assert.equal(reportDelayMs(after), 0);
  assert.equal(reportDelayMs(after + 1), 0);
});