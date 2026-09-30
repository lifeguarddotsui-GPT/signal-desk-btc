import assert from "node:assert/strict";
import test from "node:test";
import { browserRenderSummary, recordBrowserRender } from "../client/src/browser-latency";

test("same-clock browser render stage is measured without claiming server latency", () => {
  const at = 1_800_000_000_000;
  recordBrowserRender(100, 120, at);
  recordBrowserRender(400, 440, at + 1000);
  recordBrowserRender(700, 690, at + 2000);
  const result = browserRenderSummary(at + 3000);
  assert.equal(result.status, "measured");
  assert.equal(result.sampleCount, 2);
  assert.equal(result.p50Ms, 30);
  assert.match(result.note, /Not network latency/);
  assert.equal(browserRenderSummary(at + 3_700_000).status, "unavailable");
});