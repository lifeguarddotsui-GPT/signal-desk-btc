import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  WATERX_REFERENCE_CONFIRMATION_SQL,
  WATERX_ROUND_OBSERVATION_SQL,
  recordWaterxRound,
  recordWaterxSettlement,
  waterxSettlementDecision,
  waterxSettlementRejection,
  type WaterxQueryable,
  type WaterxRoundInput,
  type WaterxSettlementInput,
} from "../server/waterx/learning";

function round(overrides: Partial<WaterxRoundInput> = {}): WaterxRoundInput {
  const startMs = Date.UTC(2025, 3, 1);
  return {
    intervalMinutes: 5,
    roundId: "reference-transition-round",
    startMs,
    expiryMs: startMs + 5 * 60_000,
    anchorPrice: 100,
    anchorConfirmed: false,
    probabilityUp: 0.61,
    observedAt: new Date(startMs + 5_000).toISOString(),
    source: "WaterX",
    ...overrides,
  };
}

const isolatedUrl = process.env.WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL;
function isolatedDatabaseUrlReason(): string | undefined {
  if (!isolatedUrl)
    return "Set WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL to a disposable localhost database named waterx_reference_test.";
  try {
    const url = new URL(isolatedUrl);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
        !/(?:^|_)waterx_reference_test$/.test(dbName) || /production|(^|[-_])prod($|[-_])/i.test(dbName))
      return "The isolated reference test only accepts a loopback database with a dedicated waterx_reference_test name; production hosts and application databases are refused.";
    return undefined;
  } catch {
    return "The isolated test database URL is invalid; it is never logged.";
  }
}

test("real disposable PostgreSQL schema: provisional upgrade, immutable odds, append-only confirmations, identity isolation and verified final anchor", {
  skip: isolatedDatabaseUrlReason(),
}, async () => {
  const pool = new pg.Pool({
    connectionString: isolatedUrl,
    max: 2,
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    application_name: "waterx-reference-isolated-transaction-test",
  });
  let client = await pool.connect();
  const schema = `waterx_reference_test_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const db: WaterxQueryable = { query: q };
  try {
    await q("BEGIN");
    // The test owns only a random isolated schema in a disposable loopback DB.
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET LOCAL search_path TO "${schema}"`);
    await q(`CREATE TABLE waterx_learning_rounds (
      interval_minutes smallint NOT NULL CHECK (interval_minutes IN (5,15)),
      round_id text NOT NULL,
      start_ms bigint NOT NULL,
      expiry_ms bigint NOT NULL,
      anchor_price numeric,
      anchor_confirmed boolean NOT NULL,
      probability_up numeric,
      observed_at timestamptz NOT NULL,
      source_proof jsonb NOT NULL,
      label_status text NOT NULL DEFAULT 'unresolved',
      withheld_reason text,
      settlement_anchor_price numeric,
      settle_price numeric,
      outcome text,
      settled_at bigint,
      settlement_observed_at timestamptz,
      settlement_evidence jsonb,
      settlement_evidence_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      settlement_quarantine jsonb NOT NULL DEFAULT '[]'::jsonb,
      settlement_disputed boolean NOT NULL DEFAULT false,
      settlement_disputed_reason text,
      settlement_first_observed_at timestamptz,
      provider_settlement_at bigint,
      last_settlement_attempt_at timestamptz,
      PRIMARY KEY (interval_minutes, round_id),
      CHECK ((outcome IS NULL) OR
        (((label_status='verified' AND NOT settlement_disputed) OR
          (label_status='withheld' AND settlement_disputed))
          AND settled_at IS NOT NULL AND settle_price IS NOT NULL))
    )`);
    const migration = await readFile(path.resolve(
      process.cwd(), "migrations/waterx-reference-confirmations.sql",
    ), "utf8");
    await q(migration);
    assert.match(WATERX_ROUND_OBSERVATION_SQL, /ON CONFLICT \(interval_minutes,round_id\)/);
    assert.match(WATERX_REFERENCE_CONFIRMATION_SQL, /ON CONFLICT \(interval_minutes,round_id,anchor_price\) DO NOTHING/);

    const initial = round();
    assert.equal(await recordWaterxRound(initial, db), true);
    const first = (await q(`SELECT anchor_price,anchor_confirmed,initial_anchor_price,
        initial_anchor_confirmed,confirmed_anchor_observed_at,probability_up,observed_at
      FROM waterx_learning_rounds WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0];
    assert.deepEqual(first, {
      anchor_price: "100", anchor_confirmed: false,
      initial_anchor_price: "100", initial_anchor_confirmed: false,
      confirmed_anchor_observed_at: null, probability_up: "0.61",
      observed_at: new Date(initial.observedAt),
    });
    assert.equal((await q("SELECT * FROM waterx_research_reference_confirmations")).rowCount, 0);

    // A later authoritative poll upgrades the operational anchor, but neither
    // the first provisional feature nor first odds/probability time is changed.
    const confirmedAt = new Date(Date.parse(initial.observedAt) + 2_000).toISOString();
    assert.equal(await recordWaterxRound(round({
      anchorPrice: 101, anchorConfirmed: true, probabilityUp: 0.04, observedAt: confirmedAt,
    }), db), true);
    let row = (await q(`SELECT anchor_price,anchor_confirmed,initial_anchor_price,
        initial_anchor_confirmed,confirmed_anchor_observed_at,probability_up,observed_at
      FROM waterx_learning_rounds WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0];
    assert.deepEqual(row, {
      anchor_price: "101", anchor_confirmed: true,
      initial_anchor_price: "100", initial_anchor_confirmed: false,
      confirmed_anchor_observed_at: new Date(confirmedAt),
      probability_up: "0.61", observed_at: new Date(initial.observedAt),
    });

    // Later differing confirmations are separately retained, never substituted
    // for the first anchor or frozen probability.
    const changedAt = new Date(Date.parse(initial.observedAt) + 4_000).toISOString();
    assert.equal(await recordWaterxRound(round({
      anchorPrice: 99, anchorConfirmed: true, probabilityUp: 0.98, observedAt: changedAt,
    }), db), true);
    row = (await q(`SELECT anchor_price,initial_anchor_price,probability_up,observed_at
      FROM waterx_learning_rounds WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0];
    assert.deepEqual(row, {
      anchor_price: "101", initial_anchor_price: "100",
      probability_up: "0.61", observed_at: new Date(initial.observedAt),
    });
    assert.equal((await q(`SELECT count(*)::int AS count FROM waterx_research_reference_confirmations
      WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0].count, 2);

    // Commit the actual isolated schema, discard the first database session,
    // and reconnect. A restarted collector's duplicate replay must be
    // idempotent and must not move first evidence or change the frozen forecast.
    await q("COMMIT");
    client.release();
    client = await pool.connect();
    await q("BEGIN");
    await q(`SET LOCAL search_path TO "${schema}"`);
    assert.equal(await recordWaterxRound(round({
      anchorPrice: 99, anchorConfirmed: true, probabilityUp: 0.2,
      observedAt: new Date(Date.parse(changedAt) + 1_000).toISOString(),
    }), db), true);
    const repeated = (await q(`SELECT observed_at FROM waterx_research_reference_confirmations
      WHERE interval_minutes=5 AND round_id=$1 AND anchor_price=99`, [initial.roundId])).rows[0];
    assert.equal(repeated.observed_at.toISOString(), changedAt);
    assert.equal((await q(`SELECT probability_up FROM waterx_learning_rounds
      WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0].probability_up, "0.61");

    // Same provider ID cannot transplant either odds or anchor between
    // different closed time windows; intervals are independent composite keys.
    assert.equal(await recordWaterxRound(round({
      startMs: initial.startMs + 60_000,
      expiryMs: initial.expiryMs + 60_000,
      anchorPrice: 888, anchorConfirmed: true, probabilityUp: 0.99,
    }), db), false);
    assert.equal((await q(`SELECT count(*)::int AS count FROM waterx_research_reference_confirmations
      WHERE interval_minutes=5 AND round_id=$1 AND anchor_price=888`, [initial.roundId])).rows[0].count, 0);
    assert.equal(await recordWaterxRound(round({
      intervalMinutes: 15, startMs: initial.startMs, expiryMs: initial.startMs + 900_000,
      anchorPrice: 200, probabilityUp: 0.45,
    }), db), true);
    assert.equal((await q("SELECT count(*)::int AS count FROM waterx_learning_rounds WHERE round_id=$1", [
      initial.roundId,
    ])).rows[0].count, 2);

    // Verified settlement may reveal a different final anchor for a provisional
    // reference. Score against that actual final anchor, not the observation.
    const settlement: WaterxSettlementInput = {
      intervalMinutes: 5, roundId: initial.roundId, anchorPrice: 102, anchorConfirmed: true,
      settlePrice: 102, outcome: "Up", settledAt: initial.expiryMs + 1_000,
      observedAt: new Date(initial.expiryMs + 2_000).toISOString(), resolutionStatus: "resolved",
    };
    const provisionalRow = {
      interval_minutes: 5, round_id: initial.roundId, expiry_ms: initial.expiryMs,
      anchor_price: 100, anchor_confirmed: false, outcome: null,
    };
    assert.equal(waterxSettlementRejection(settlement, provisionalRow), null);
    assert.equal(waterxSettlementDecision(settlement, provisionalRow).kind, "accept");
    const rejectedFirst = {
      ...settlement,
      outcome: "Down",
      observedAt: new Date(initial.expiryMs + 1_500).toISOString(),
    };
    assert.equal(await recordWaterxSettlement(rejectedFirst, db), false);
    const firstObservationState = (await q(`SELECT settlement_first_observed_at,first_verified_at
      FROM waterx_learning_rounds WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0];
    assert.equal(firstObservationState.settlement_first_observed_at.toISOString(), rejectedFirst.observedAt);
    assert.equal(firstObservationState.first_verified_at, null);
    assert.equal(await recordWaterxSettlement(settlement, db), true);
    const settled = (await q(`SELECT anchor_price,initial_anchor_price,initial_anchor_confirmed,
        anchor_confirmed,confirmed_anchor_observed_at,settlement_anchor_price,
        settle_price,outcome,label_status,settlement_disputed,
        settlement_first_observed_at,first_verified_at,
        probability_up,observed_at
      FROM waterx_learning_rounds WHERE interval_minutes=5 AND round_id=$1`, [initial.roundId])).rows[0];
    assert.deepEqual(settled, {
      anchor_price: "101", initial_anchor_price: "100", initial_anchor_confirmed: false,
      anchor_confirmed: true, confirmed_anchor_observed_at: new Date(confirmedAt),
      settlement_anchor_price: "102", settle_price: "102", outcome: "Up",
      label_status: "verified", settlement_disputed: false,
      settlement_first_observed_at: new Date(rejectedFirst.observedAt),
      first_verified_at: new Date(settlement.observedAt),
      probability_up: "0.61", observed_at: new Date(initial.observedAt),
    });
    assert.equal((await q(`SELECT count(*)::int AS count FROM waterx_research_reference_confirmations
      WHERE interval_minutes=5 AND round_id=$1 AND anchor_price=102`, [initial.roundId])).rows[0].count, 1);

    // A contradictory confirmed price cannot relabel a verified row; the
    // existing rejection/revision gate leaves outcome untouched.
    const conflicting = { ...settlement, anchorPrice: 103, settlePrice: 103, outcome: "Up" };
    assert.equal(waterxSettlementDecision(conflicting, {
      interval_minutes: 5, round_id: initial.roundId, expiry_ms: initial.expiryMs,
      anchor_price: 102, anchor_confirmed: true, outcome: "Up",
      settlement_anchor_price: 102, settle_price: 102, settled_at: settlement.settledAt,
      settlement_evidence: {
        resolutionStatus: "resolved", anchorPrice: 102, anchorConfirmed: true,
        settlePrice: 102, outcome: "Up", settledAt: settlement.settledAt,
      },
    }).kind, "disputed");
    await assert.rejects(q(`UPDATE waterx_research_reference_confirmations
      SET observed_at=clock_timestamp() WHERE interval_minutes=5 AND round_id=$1 AND anchor_price=102`,
    [initial.roundId]), /append-only/);
  } finally {
    await q("ROLLBACK").catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    client.release();
    await pool.end();
  }
});