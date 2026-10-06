import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ResearchChoice } from "../shared/waterx-research";
import { WATERX_RESEARCH_POLICY } from "../shared/waterx-research";
import {
  captureResearchFeatureSupplement,
  type ResearchFeatureSupplementQueryable,
} from "../server/waterx/research-feature-supplement";

const decisionAtMs = Date.now();

function choice(): ResearchChoice {
  const expiryMs = decisionAtMs + 60_000;
  const startMs = expiryMs - 5 * 60_000;
  return {
    intervalMinutes: 5,
    roundId: "supplement-choice",
    startMs,
    expiryMs,
    checkpointAtMs: decisionAtMs - 1_000,
    decisionAtMs,
    state: "FROZEN",
    side: "UP",
    probabilityUp: 0.56,
    probabilityDown: 0.44,
    choiceSource: "market_baseline",
    modelVersion: null,
    calibrationVersion: null,
    policyVersion: WATERX_RESEARCH_POLICY.version,
    noChoiceCode: null,
    noChoiceReason: null,
    evidence: {
      reference: {
        price: 100,
        quality: "provisional",
        source: "WaterX",
        appObservedAtMs: decisionAtMs - 500,
      },
      market: {
        probabilityUp: 0.56,
        probabilityDown: 0.44,
        appObservedAtMs: decisionAtMs - 500,
        timestampKind: "app-observed",
      },
      comparison: {
        source: "Coinbase",
        price: null,
        sourceAtMs: null,
        receivedAtMs: null,
        return1m: null,
        return3m: null,
        realizedVolatility: null,
        tickCount: 0,
        coverage: "unavailable",
        reason: "Not persisted before the canonical choice commit.",
      },
      qualityFlags: ["COINBASE_LOOKBACK_INCOMPLETE"],
      tieBreakApplied: false,
    },
    settlement: {
      state: "pending",
      outcome: null,
      brier: null,
      logLoss: null,
      referenceDiscrepancyUsd: null,
      labelAvailableAt: null,
    },
  };
}

function point(ms: number, index: number) {
  return {
    id: String(index),
    source_at: new Date(ms),
    received_at: new Date(ms + 100),
    price: String(100 + index / 1000),
  };
}

class FakeSupplementDatabase implements ResearchFeatureSupplementQueryable {
  readonly queries: { sql: string; values: unknown[] }[] = [];
  readonly persisted = new Map<string, Record<string, unknown>>();
  ticks: Record<string, unknown>[] = [];
  storedChoice: Record<string, unknown>;

  constructor(readonly original: ResearchChoice) {
    this.storedChoice = {
      interval_minutes: original.intervalMinutes,
      round_id: original.roundId,
      start_ms: original.startMs,
      expiry_ms: original.expiryMs,
      decision_at_ms: original.decisionAtMs,
      state: original.state,
      probability_up: original.probabilityUp,
      probability_down: original.probabilityDown,
      evidence: JSON.parse(JSON.stringify(original.evidence)),
    };
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.queries.push({ sql, values });
    if (sql.includes("INSERT INTO waterx_research_feature_supplements")) {
      const snapshot = JSON.parse(String(values[5])) as Record<string, unknown>;
      const key = values.slice(0, 5).join(":");
      if (!this.persisted.has(key)) this.persisted.set(key, snapshot);
      return { rows: [] };
    }
    if (sql.includes("FROM waterx_research_choices"))
      return { rows: [this.storedChoice as T] };
    if (sql.includes("FROM waterx_comparison_ticks"))
      return { rows: this.ticks as T[] };
    if (sql.includes("FROM waterx_research_feature_supplements")) {
      const key = values.join(":");
      const snapshot = this.persisted.get(key);
      return { rows: snapshot ? [{ feature_snapshot: snapshot } as T] : [] };
    }
    throw new Error(`Unexpected supplement SQL: ${sql}`);
  }
}

test("captures only source- and receive-stamped ticks at the exact original decision without mutating choice evidence", async () => {
  const frozen = choice();
  const originalEvidence = JSON.stringify(frozen.evidence);
  const db = new FakeSupplementDatabase(frozen);
  const earliest = decisionAtMs - 180_000;
  db.ticks = Array.from({ length: 181 }, (_, index) =>
    point(earliest + index * 1_000, index));
  db.ticks.push(
    { ...point(decisionAtMs + 1, 1000), id: "future-source" },
    { ...point(decisionAtMs - 50, 1001), id: "late-receive",
      received_at: new Date(decisionAtMs + 1) },
  );
  const enriched = await captureResearchFeatureSupplement(frozen, db);
  assert.equal(enriched.evidence.comparison.coverage, "complete");
  assert.ok(enriched.evidence.comparison.tickCount >= 3);
  assert.equal(JSON.stringify(frozen.evidence), originalEvidence);
  assert.notEqual(enriched, frozen);
  const tickQuery = db.queries.find(query => query.sql.includes("FROM waterx_comparison_ticks"))!;
  assert.match(tickQuery.sql, /source_at <=/);
  assert.match(tickQuery.sql, /received_at <=/);
  const supplementInsert = db.queries.find(query =>
    query.sql.includes("INSERT INTO waterx_research_feature_supplements"))!;
  const snapshot = JSON.parse(String(supplementInsert.values[5])) as {
    comparison: { sourceAtMs: number; receivedAtMs: number };
    ticks: { id: string; sourceAtMs: number; receivedAtMs: number }[];
  };
  assert.ok(snapshot.comparison.sourceAtMs <= decisionAtMs);
  assert.ok(snapshot.comparison.receivedAtMs <= decisionAtMs);
  assert.ok(snapshot.ticks.every(tick =>
    tick.sourceAtMs <= decisionAtMs && tick.receivedAtMs <= decisionAtMs));
  assert.equal(snapshot.ticks.some(tick => tick.id === "future-source" || tick.id === "late-receive"), false);
});

test("only complete feature windows are persisted and raw market/reference changes fail exact-choice validation", async () => {
  const frozen = choice();
  const partialDb = new FakeSupplementDatabase(frozen);
  partialDb.ticks = [point(decisionAtMs - 1000, 1)];
  const partial = await captureResearchFeatureSupplement(frozen, partialDb);
  assert.equal(partial.evidence.comparison.coverage, "partial");
  assert.equal(partialDb.persisted.size, 0);

  const modified = choice();
  modified.evidence.reference.price = 101;
  const exactDb = new FakeSupplementDatabase(frozen);
  await assert.rejects(
    captureResearchFeatureSupplement(modified, exactDb),
    /raw reference and market evidence do not match/,
  );
});

test("feature supplement migration guards exact-choice cutoff and append-only rows", async () => {
  const sql = await readFile(new URL("../migrations/waterx-research-features.sql", import.meta.url), "utf8");
  assert.match(sql, /c\.decision_at_ms=NEW\.decision_at_ms/);
  assert.match(sql, /sourceAtMs.*NEW\.decision_at_ms/s);
  assert.match(sql, /receivedAtMs.*NEW\.decision_at_ms/s);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON waterx_research_feature_supplements/);
  assert.match(sql, /NOT \(feature_snapshot \? 'reference'\)/);
  assert.match(sql, /NOT \(feature_snapshot \? 'market'\)/);
});