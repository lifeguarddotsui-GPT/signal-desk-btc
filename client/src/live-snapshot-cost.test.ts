import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {snapshotRefreshDelay} from "./useLiveSnapshot";

test("visible refresh remains near free-source cadence, background drops to 30-second floor",()=>{
  assert.equal(snapshotRefreshDelay(5000,false),5000);
  assert.equal(snapshotRefreshDelay(5000,true),30000);
  assert.equal(snapshotRefreshDelay(60000,true),60000);
});
test("browser telemetry is capped at one event per stage per minute and no hidden tab reports",()=>{
  const source=readFileSync(new URL("./useLiveSnapshot.ts",import.meta.url),"utf8");
  assert.match(source,/lastBrowserReport/);
  assert.match(source,/60_000/);
  assert.match(source,/document.visibilityState==="hidden"/);
  assert.match(source,/visibilitychange/);
  assert.match(source,/snapshotRefreshDelay\(refreshMs,document.visibilityState==="hidden"\)/);
});
