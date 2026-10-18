import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { beginExecutionSubmission } from "../server/agent/execution-store";

test("submission transition requires an explicit released global database gate", async () => {
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[]) => {
    queries.push({ sql, args });
    return { rows: [], rowCount: 0 };
  } } as unknown as Pool;
  const result = await beginExecutionSubmission("intent-1", "owner-1", db);
  assert.equal(result, null);
  assert.equal(queries.length, 1);
  const sql = queries[0].sql;
  assert.match(sql, /status='PREPARED'/);
  assert.match(sql, /status='UNKNOWN'/);
  assert.match(sql, /bluewater_agent_execution_control/);
  assert.match(sql, /gate\.singleton=true AND gate\.disabled=false/);
  assert.match(sql, /s\.status='ARMED'/);
  assert.match(sql, /s\.expires_at_ms>\$3/);
  assert.match(sql, /a\.account_id=i\.account_id/);
  assert.match(sql, /a\.policy_version=i\.policy_version/);
  assert.deepEqual(queries[0].args.slice(0, 2), ["intent-1", "owner-1"]);
});
