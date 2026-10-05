import test from "node:test";
import assert from "node:assert/strict";
import {allowedSourcePath,sourceSnapshot} from "../script/source-snapshot";
test("release snapshot includes decision, collector, Agent, UI, schema and edge; excludes private surfaces",async()=>{
  for(const file of ["server/agent/worker.ts","server/waterx/timed-decision-store.ts","client/src/App.tsx",
    "migrations/waterx-timed-decisions.sql","edge/worker.ts"])assert(allowedSourcePath(file));
  for(const file of [".env","attached_assets/private.ts","reports/private.ts","server/.env",
    ".git/config",".agents/memory/MEMORY.md","client/src/backups/dump.sql"])assert(!allowedSourcePath(file));
  const snapshot=await sourceSnapshot();
  assert(snapshot.entries.some(e=>e.file==="server/agent/worker.ts"));
  assert(snapshot.entries.some(e=>e.file==="script/source-snapshot.ts"));
  assert.equal(snapshot.digest.length,64);
});
