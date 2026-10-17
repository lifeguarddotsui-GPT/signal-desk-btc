import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { MAINNET_IDENTITY } from "../server/agent/protocol";
import {
  verifiedSuccessProof, reconcileUnknownSubmissions,
  type PendingExecution, type FinalityObservation,
} from "../server/agent/submission-reconciliation";

const digest = "1".repeat(44);
const owner = "0x" + "a".repeat(64);
const sender = "0x" + "b".repeat(64);
const pending: PendingExecution = { id: "intent-1", owner, status: "UNKNOWN", transaction_digest: digest };
const success: FinalityObservation = {
  kind: "FINAL_SUCCESS", digest, chain: MAINNET_IDENTITY.chainIdentifier, sender,
};
test("only the identical finalized mainnet digest can prove successful submission, never an order fill", () => {
  assert.deepEqual(verifiedSuccessProof(pending, success), {
    kind: "SUI_TRANSACTION_SUCCESS_ONLY", digest, network: "sui:mainnet", sender,
  });
  assert.equal(verifiedSuccessProof({ ...pending, status: "FILLED" }, success), null);
  assert.equal(verifiedSuccessProof({ ...pending, transaction_digest: "2".repeat(44) }, success), null);
  assert.equal(verifiedSuccessProof({ ...pending, owner: "not-an-address" }, success), null);
  assert.equal(verifiedSuccessProof(pending, { ...success, chain: "testnet" }), null);
  assert.equal(verifiedSuccessProof(pending, { ...success, sender: "not-address" }), null);
  assert.equal(verifiedSuccessProof(pending, { ...success, digest: "3".repeat(44) }), null);
  assert.equal(verifiedSuccessProof(pending, { kind: "INDETERMINATE", reason: "RPC_UNAVAILABLE" }), null);
  assert.equal(verifiedSuccessProof(pending, { kind: "INDETERMINATE", reason: "NOT_VERIFIED_SUCCESS" }), null);
});

type MockQuery = { sql: string; params?: unknown[] };
function fakeDb(rows: PendingExecution[], updatedRows: number = 1) {
  const statements: MockQuery[] = [];
  const db = { query: async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    return sql.trimStart().startsWith("SELECT")
      ? { rows, rowCount: rows.length }
      : { rows: updatedRows ? [{ id: "intent-1" }] : [], rowCount: updatedRows };
  } };
  return { db: db as unknown as Pick<Pool, "query">, statements };
}
test("reconciliation promotes only an UNKNOWN receipt to ACCEPTED, with restricted optimistic DB update", async () => {
  const { db, statements } = fakeDb([pending]);
  const result = await reconcileUnknownSubmissions(db, async () => success);
  assert.deepEqual(result, { inspected: 1, accepted: 1, held: 0, failures: 0 });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /status='UNKNOWN'/);
  assert.match(statements[0].sql, /LIMIT 25/);
  assert.match(statements[1].sql, /status='ACCEPTED'/);
  assert.match(statements[1].sql, /status='UNKNOWN'/);
  assert.doesNotMatch(statements[1].sql, /status='FILLED'/);
  assert.equal(statements[1].params?.[2], digest);
  assert.equal((JSON.parse(statements[1].params?.[3] as string)).kind, "SUI_TRANSACTION_SUCCESS_ONLY");
});
test("missing receipt, chain mismatch and finalized failed effect never release a reservation", async () => {
  for (const observation of [
    { kind: "INDETERMINATE", reason: "NOT_FOUND" },
    { kind: "INDETERMINATE", reason: "NOT_VERIFIED_SUCCESS" },
    { kind: "FINAL_SUCCESS", digest, chain: "testnet", sender },
  ] as FinalityObservation[]) {
    const { db, statements } = fakeDb([pending]);
    const result = await reconcileUnknownSubmissions(db, async () => observation);
    assert.deepEqual(result, { inspected: 1, accepted: 0, held: 1, failures: 0 });
    assert.equal(statements.length, 1);
  }
});
test("RPC exceptions cannot submit, promote, retry, or release; concurrent update is respected", async () => {
  const first = fakeDb([pending]);
  assert.deepEqual(await reconcileUnknownSubmissions(first.db, async () => { throw new Error("timeout"); }), {
    inspected: 1, accepted: 0, held: 0, failures: 1,
  });
  assert.equal(first.statements.length, 1);
  const second = fakeDb([pending], 0);
  assert.deepEqual(await reconcileUnknownSubmissions(second.db, async () => success), {
    inspected: 1, accepted: 0, held: 1, failures: 0,
  });
});
test("empty queue has zero network calls and no updates", async () => {
  const { db, statements } = fakeDb([]);
  let calls = 0;
  assert.deepEqual(await reconcileUnknownSubmissions(db, async () => { calls++; return success; }), {
    inspected: 0, accepted: 0, held: 0, failures: 0,
  });
  assert.equal(calls, 0);
  assert.equal(statements.length, 1);
});
