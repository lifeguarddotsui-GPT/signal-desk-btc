import {
  WATERX_RESEARCH_POLICY as POLICY,
  type ResearchChoice,
  type ResearchComparison,
} from "../../shared/waterx-research";
import { COMPARISON_SOURCE } from "../btc/chart";
import { comparisonFeatures, type ResearchTick } from "./research-decision";

const MAX_LOOKBACK_TICKS = 20_000;

export type ResearchFeatureSupplementQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type PersistedChoice = {
  interval_minutes: unknown;
  round_id: unknown;
  start_ms: unknown;
  expiry_ms: unknown;
  decision_at_ms: unknown;
  state: unknown;
  probability_up: unknown;
  probability_down: unknown;
  evidence: unknown;
};

type PersistedTick = {
  id: unknown;
  source_at: unknown;
  received_at: unknown;
  price: unknown;
};

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const numeric = finite(value);
  if (numeric !== null) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertFrozenExactChoice(choice: ResearchChoice, row: PersistedChoice | undefined): void {
  if (!row || row.state !== "FROZEN" ||
      finite(row.interval_minutes) !== choice.intervalMinutes ||
      String(row.round_id) !== choice.roundId ||
      finite(row.start_ms) !== choice.startMs ||
      finite(row.expiry_ms) !== choice.expiryMs ||
      finite(row.decision_at_ms) !== choice.decisionAtMs ||
      finite(row.probability_up) !== choice.probabilityUp ||
      finite(row.probability_down) !== choice.probabilityDown)
    throw new Error("Research feature supplement requires the exact committed frozen choice.");
  const storedEvidence = parseObject(row.evidence);
  const suppliedEvidence = choice.evidence as unknown as Record<string, unknown>;
  if (!storedEvidence ||
      canonical(storedEvidence.reference) !== canonical(suppliedEvidence.reference) ||
      canonical(storedEvidence.market) !== canonical(suppliedEvidence.market))
    throw new Error("Committed raw reference and market evidence do not match the supplied choice.");
}

function comparisonSnapshot(
  comparison: ResearchComparison,
  ticks: ResearchTick[],
): Record<string, unknown> {
  return {
    comparison,
    ticks: ticks.map(tick => ({
      id: tick.id,
      source: "Coinbase",
      sourceAtMs: tick.sourceAtMs,
      receivedAtMs: tick.receivedAtMs,
      price: tick.price,
    })),
  };
}

function withComparison(choice: ResearchChoice, comparison: ResearchComparison): ResearchChoice {
  return {
    ...choice,
    evidence: {
      ...choice.evidence,
      reference: { ...choice.evidence.reference },
      market: { ...choice.evidence.market },
      comparison: { ...comparison },
      qualityFlags: [...choice.evidence.qualityFlags],
    },
  };
}

/**
 * Queries the persisted Coinbase archive strictly as-of the original frozen
 * decision and adds the result only to a returned ephemeral choice. It never
 * rewrites waterx_research_choices or mutates the caller's choice.
 *
 * Incomplete windows are returned as partial/unavailable evidence but are not
 * inserted into the complete-feature supplement ledger. Callers may use the
 * returned choice for forward shadow inference only while its original
 * pre-expiry decision window is still open.
 */
export async function captureResearchFeatureSupplement(
  choice: ResearchChoice,
  db: ResearchFeatureSupplementQueryable,
): Promise<ResearchChoice> {
  if ((choice.intervalMinutes !== 5 && choice.intervalMinutes !== 15) ||
      choice.state !== "FROZEN" || choice.choiceSource !== "market_baseline" ||
      !choice.roundId.trim() ||
      ![choice.startMs, choice.expiryMs, choice.decisionAtMs].every(Number.isSafeInteger) ||
      choice.expiryMs - choice.startMs !== choice.intervalMinutes * 60_000 ||
      choice.decisionAtMs < choice.startMs || choice.decisionAtMs >= choice.expiryMs)
    throw new Error("Research feature supplementation requires a valid immutable pre-expiry market-baseline choice.");

  const exact = await db.query<PersistedChoice>(
    `SELECT interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms,state,
            probability_up,probability_down,evidence
       FROM waterx_research_choices
      WHERE interval_minutes=$1 AND round_id=$2
        AND start_ms=$3 AND expiry_ms=$4 AND decision_at_ms=$5
      LIMIT 1`,
    [choice.intervalMinutes, choice.roundId, choice.startMs, choice.expiryMs, choice.decisionAtMs],
  );
  assertFrozenExactChoice(choice, exact.rows[0]);

  const lookbackStartMs = choice.decisionAtMs - POLICY.comparisonLookbackMs -
    POLICY.maxComparisonGapMs;
  const tickResult = await db.query<PersistedTick>(
    `SELECT id,source_at,received_at,price
       FROM waterx_comparison_ticks
      WHERE source=$1
        AND source_at >= to_timestamp($2::double precision/1000.0)
        AND source_at <= to_timestamp($3::double precision/1000.0)
        AND received_at <= to_timestamp($3::double precision/1000.0)
      ORDER BY source_at DESC,id DESC
      LIMIT $4`,
    [COMPARISON_SOURCE, lookbackStartMs, choice.decisionAtMs, MAX_LOOKBACK_TICKS],
  );
  const ticks = tickResult.rows.flatMap(row => {
    const sourceAtMs = asMs(row.source_at);
    const receivedAtMs = asMs(row.received_at);
    const price = finite(row.price);
    if (sourceAtMs === null || receivedAtMs === null || price === null || price <= 0 ||
        sourceAtMs > choice.decisionAtMs || receivedAtMs > choice.decisionAtMs)
      return [];
    return [{ id: String(row.id), sourceAtMs, receivedAtMs, price }];
  }).sort((a, b) => a.sourceAtMs - b.sourceAtMs || a.id.localeCompare(b.id));
  const comparison = comparisonFeatures(
    ticks,
    choice.decisionAtMs,
    tickResult.rows.length >= MAX_LOOKBACK_TICKS,
  );

  // Incomplete data is useful as an explicit shadow abstention, but it must
  // not occupy the exact-choice supplement key and block a later complete
  // extraction. The source archive remains authoritative and append-only.
  if (comparison.coverage !== "complete")
    return withComparison(choice, comparison);

  const snapshot = comparisonSnapshot(comparison, ticks);
  await db.query(
    `INSERT INTO waterx_research_feature_supplements
       (interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms,feature_snapshot)
     SELECT $1,$2,$3,$4,$5,$6::jsonb
      WHERE EXISTS (
        SELECT 1 FROM waterx_research_choices c
         WHERE c.interval_minutes=$1 AND c.round_id=$2
           AND c.start_ms=$3 AND c.expiry_ms=$4 AND c.decision_at_ms=$5
           AND c.state='FROZEN'
           AND c.evidence->'reference'=$7::jsonb
           AND c.evidence->'market'=$8::jsonb
      )
     ON CONFLICT (interval_minutes,round_id,start_ms,expiry_ms,decision_at_ms) DO NOTHING`,
    [choice.intervalMinutes, choice.roundId, choice.startMs, choice.expiryMs,
      choice.decisionAtMs, JSON.stringify(snapshot),
      JSON.stringify(choice.evidence.reference), JSON.stringify(choice.evidence.market)],
  );
  const persisted = await db.query<{ feature_snapshot: unknown }>(
    `SELECT feature_snapshot FROM waterx_research_feature_supplements
      WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3
        AND expiry_ms=$4 AND decision_at_ms=$5`,
    [choice.intervalMinutes, choice.roundId, choice.startMs, choice.expiryMs, choice.decisionAtMs],
  );
  const storedSnapshot = parseObject(persisted.rows[0]?.feature_snapshot);
  const storedComparison = parseObject(storedSnapshot?.comparison);
  if (!storedComparison || storedComparison.coverage !== "complete" ||
      canonical(storedComparison) !== canonical(snapshot.comparison))
    throw new Error("Exact-choice feature supplement was not persisted with matching complete source evidence.");
  return withComparison(choice, comparison);
}