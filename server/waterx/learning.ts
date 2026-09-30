import pg from "pg";

export type WaterxInterval = 5 | 15;
export type WaterxRoundInput = {
  intervalMinutes: WaterxInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  probabilityUp: number | null;
  observedAt: string;
  source: "WaterX";
};
export type WaterxSettlementInput = {
  intervalMinutes: WaterxInterval;
  roundId: string;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  settlePrice: number | null;
  outcome: string | null;
  settledAt: number | null;
  observedAt: string;
  /** Required for a label; omission is retained as unverified evidence. */
  resolutionStatus?: string;
};
export type FrozenWaterxObservation = {
  intervalMinutes: WaterxInterval;
  roundId: string;
  probabilityUp: number | null;
  observedAt: string;
};
export type PendingWaterxSettlement = {
  roundId: string;
  startMs: number;
  expiryMs: number;
};
const SETTLEMENT_RETRY_COOLDOWN_MS = 30_000;

/** The database mirrors this policy with its composite key and DO NOTHING. */
export function freezeWaterxObservation(
  existing: FrozenWaterxObservation | null,
  proposed: FrozenWaterxObservation,
): FrozenWaterxObservation {
  assertInterval(proposed.intervalMinutes);
  assertRoundId(proposed.roundId);
  if (existing && (existing.intervalMinutes !== proposed.intervalMinutes ||
      existing.roundId !== proposed.roundId))
    throw new Error("Cannot freeze observations across WaterX round identities");
  return existing ?? proposed;
}

export function isWaterxSettlementPending(row: {
  expiryMs: number;
  labelStatus: string;
  outcome: string | null;
  lastAttemptAtMs?: number | null;
}, nowMs: number): boolean {
  return row.expiryMs < nowMs && row.outcome === null &&
    (row.labelStatus === "unresolved" || row.labelStatus === "withheld") &&
    (row.lastAttemptAtMs == null ||
      nowMs - row.lastAttemptAtMs >= SETTLEMENT_RETRY_COOLDOWN_MS);
}

export function waterxSettlementResult(found: boolean, verified: boolean): boolean {
  return found && verified;
}

/** The first app-observed accepted label time is immutable across later retries. */
export function firstAcceptedWaterxLabelAvailableMs(
  existingAvailableMs: number | null,
  accepted: boolean,
  observedAtMs: number,
): number | null {
  return existingAvailableMs ?? (accepted ? observedAtMs : null);
}

type QueryResult = { rows: any[]; rowCount?: number | null };
type Queryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect?(): Promise<{
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    release(): void;
  }>;
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) as unknown as Queryable;

function assertInterval(interval: number): asserts interval is WaterxInterval {
  if (interval !== 5 && interval !== 15) throw new Error("WaterX interval must be 5 or 15 minutes");
}

function assertRoundId(roundId: string) {
  if (typeof roundId !== "string" || !roundId.trim())
    throw new Error("WaterX round ID is required");
}

function finiteOrNull(name: string, value: number | null) {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${name} must be finite or null`);
}

function validObservedAt(observedAt: string): number {
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) throw new Error("observedAt must be a valid timestamp");
  return ms;
}

function isMissingSchema(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ["42P01", "3F000", "42703"].includes(String((error as { code?: unknown }).code ?? ""));
}

function unavailable(reason = "WaterX learning tables are unavailable; no legacy data was read or changed.") {
  return { status: "unavailable", reason, promotedForecast: null, action: null };
}

/**
 * Records only prospective WaterX evidence. The composite key isolates
 * intervals; the initial anchor/proof are immutable. A null quote may be filled
 * once by a later valid pre-expiry observation, while a present quote is frozen.
 */
export async function recordWaterxRound(input: WaterxRoundInput): Promise<void> {
  assertInterval(input.intervalMinutes);
  assertRoundId(input.roundId);
  if (input.source !== "WaterX") throw new Error("WaterX source proof is required");
  if (!Number.isFinite(input.startMs) || !Number.isFinite(input.expiryMs) ||
      input.startMs <= 0 || input.expiryMs <= input.startMs)
    throw new Error("WaterX round timestamps are invalid");
  finiteOrNull("anchorPrice", input.anchorPrice);
  finiteOrNull("probabilityUp", input.probabilityUp);
  if (input.anchorPrice !== null && input.anchorPrice <= 0)
    throw new Error("anchorPrice must be positive");
  if (typeof input.anchorConfirmed !== "boolean" ||
      (input.anchorConfirmed && input.anchorPrice === null))
    throw new Error("A confirmed WaterX anchor must include a verified anchorPrice");
  if (input.probabilityUp !== null && (input.probabilityUp < 0 || input.probabilityUp > 1))
    throw new Error("probabilityUp must be between 0 and 1");
  const observedMs = validObservedAt(input.observedAt);
  if (observedMs >= input.expiryMs)
    throw new Error("WaterX baseline observation must be pre-expiry");
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query(
      `INSERT INTO waterx_learning_rounds
        (interval_minutes,round_id,start_ms,expiry_ms,anchor_price,anchor_confirmed,
         probability_up,observed_at,source_proof,label_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unresolved')
       ON CONFLICT (interval_minutes,round_id) DO UPDATE SET
         probability_up=COALESCE(waterx_learning_rounds.probability_up,EXCLUDED.probability_up),
         observed_at=CASE WHEN waterx_learning_rounds.probability_up IS NULL
                               AND EXCLUDED.probability_up IS NOT NULL
                          THEN EXCLUDED.observed_at ELSE waterx_learning_rounds.observed_at END,
         source_proof=waterx_learning_rounds.source_proof || EXCLUDED.source_proof`,
       [input.intervalMinutes, input.roundId, input.startMs, input.expiryMs,
        input.anchorPrice, input.anchorConfirmed, input.probabilityUp,
        input.observedAt, JSON.stringify({ provider: input.source, evidenceKind: "WaterX round observation" })],
    );
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
}

function normalizedOutcome(outcome: string | null): "Up" | "Down" | null {
  if (outcome === null) return null;
  const normalized = outcome.trim().toLowerCase();
  if (normalized === "up") return "Up";
  if (normalized === "down") return "Down";
  return null;
}

export function waterxOutcomeForPrices(anchorPrice: number, settlePrice: number): "Up" | "Down" {
  return settlePrice >= anchorPrice ? "Up" : "Down";
}

export function waterxSettlementRejection(input: WaterxSettlementInput, round: {
  expiry_ms: number | string;
  anchor_price: string | number | null;
  anchor_confirmed: boolean;
  outcome: string | null;
}): string | null {
  const expiryMs = Number(round.expiry_ms);
  const storedAnchor = round.anchor_price === null ? null : Number(round.anchor_price);
  if (input.resolutionStatus !== "resolved") return "WaterX resolutionStatus is not verified as resolved.";
  if (storedAnchor === null || !input.anchorConfirmed ||
      input.anchorPrice === null || input.anchorPrice !== storedAnchor)
    return "Final confirmed WaterX anchor is missing or contradicts the frozen prospective anchor.";
  if (input.settlePrice === null || !Number.isFinite(input.settlePrice) || input.settlePrice <= 0)
    return "Actual WaterX settlePrice is missing or invalid.";
  const normalized = normalizedOutcome(input.outcome);
  if (!normalized) return "WaterX outcome is missing or is not Up/Down.";
  if (normalized !== waterxOutcomeForPrices(storedAnchor, input.settlePrice))
    return "WaterX outcome contradicts settlePrice versus anchor (TWAP >= anchor is Up).";
  if (input.settledAt === null || !Number.isFinite(input.settledAt) || input.settledAt <= expiryMs)
    return "WaterX settledAt does not prove settlement after the round end.";
  if (round.outcome !== null) return "A verified WaterX label is already frozen.";
  return null;
}

/**
 * Stores settlement evidence even when it is incomplete, but creates a label
 * only from a resolved WaterX response with internally consistent prices and
 * an actual post-expiry settlement timestamp.
 */
export async function recordWaterxSettlement(input: WaterxSettlementInput): Promise<boolean> {
  assertInterval(input.intervalMinutes);
  assertRoundId(input.roundId);
  finiteOrNull("anchorPrice", input.anchorPrice);
  finiteOrNull("settlePrice", input.settlePrice);
  if (input.settledAt !== null && !Number.isFinite(input.settledAt))
    throw new Error("settledAt must be finite or null");
  validObservedAt(input.observedAt);
  if (!process.env.DATABASE_URL) return false;
  let client: Awaited<ReturnType<NonNullable<Queryable["connect"]>>> | null = null;
  try {
    client = pool.connect ? await pool.connect() : null;
    const db = client ?? pool;
    if (client) await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT expiry_ms,anchor_price,anchor_confirmed,outcome
         FROM waterx_learning_rounds
        WHERE interval_minutes=$1 AND round_id=$2 FOR UPDATE`,
      [input.intervalMinutes, input.roundId],
    );
    if (!rows[0]) {
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(false, false);
    }
    if (rows[0].outcome !== null) {
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(true, true);
    }
    const rejection = waterxSettlementRejection(input, rows[0]);
    const accepted = rejection === null;
    const acceptedAtMs = firstAcceptedWaterxLabelAvailableMs(
      null, accepted, Date.parse(input.observedAt));
    const acceptedAt = acceptedAtMs === null ? null : new Date(acceptedAtMs).toISOString();
    await db.query(
      `UPDATE waterx_learning_rounds SET
         settlement_evidence=CASE WHEN outcome IS NOT NULL THEN settlement_evidence ELSE $3::jsonb END,
        settlement_observed_at=CASE WHEN outcome IS NOT NULL THEN settlement_observed_at
                                    WHEN $5 THEN $4 ELSE NULL END,
         label_status=CASE WHEN outcome IS NOT NULL THEN label_status
                           WHEN $5 THEN 'verified' ELSE 'withheld' END,
         withheld_reason=CASE WHEN outcome IS NOT NULL THEN withheld_reason
                              WHEN $5 THEN NULL ELSE $6 END,
         anchor_confirmed=CASE WHEN outcome IS NULL AND $5 THEN true
                               ELSE anchor_confirmed END,
         settlement_anchor_price=CASE WHEN outcome IS NULL AND $5 THEN $7
                                      ELSE settlement_anchor_price END,
         settle_price=CASE WHEN outcome IS NULL AND $5 THEN $8 ELSE settle_price END,
         outcome=CASE WHEN outcome IS NULL AND $5 THEN $9 ELSE outcome END,
         settled_at=CASE WHEN outcome IS NULL AND $5 THEN $10 ELSE settled_at END
       WHERE interval_minutes=$1 AND round_id=$2`,
      [input.intervalMinutes, input.roundId,
        JSON.stringify({
          source: "WaterX",
          resolutionStatus: input.resolutionStatus ?? null,
          anchorPrice: input.anchorPrice,
          anchorConfirmed: input.anchorConfirmed,
          settlePrice: input.settlePrice,
          outcome: input.outcome,
          settledAt: input.settledAt,
          observedAt: input.observedAt,
          accepted,
        }),
        acceptedAt, accepted, rejection ?? null, input.anchorPrice,
        input.settlePrice, normalizedOutcome(input.outcome), input.settledAt],
    );
    if (client) await db.query("COMMIT");
    return waterxSettlementResult(true, accepted);
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original database error */ }
    }
    if (!isMissingSchema(error)) throw error;
    return false;
  } finally {
    client?.release();
  }
}

/**
 * Recovers observed rounds after a worker restart. Settlement polling is bounded,
 * interval-scoped, and never synthesizes a round that was not already recorded.
 */
export async function listPendingWaterxSettlements(
  intervalMinutes: WaterxInterval,
  limit = 50,
): Promise<PendingWaterxSettlement[]> {
  assertInterval(intervalMinutes);
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("pending settlement limit must be a positive integer");
  const boundedLimit = Math.min(limit, 500);
  if (!process.env.DATABASE_URL) return [];
  const nowMs = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT round_id,start_ms,expiry_ms,label_status,outcome,last_settlement_attempt_at
         FROM waterx_learning_rounds
        WHERE interval_minutes=$1 AND expiry_ms < $2
          AND label_status IN ('unresolved','withheld') AND outcome IS NULL
          AND (last_settlement_attempt_at IS NULL OR
               last_settlement_attempt_at <= to_timestamp($2::double precision/1000)-interval '30 seconds')
         ORDER BY last_settlement_attempt_at ASC NULLS FIRST,expiry_ms ASC,round_id ASC
         LIMIT $3`,
      [intervalMinutes, nowMs, boundedLimit],
    );
    return rows.filter(row => isWaterxSettlementPending({
      expiryMs: Number(row.expiry_ms),
      labelStatus: String(row.label_status),
      outcome: row.outcome,
      lastAttemptAtMs: row.last_settlement_attempt_at === null
        ? null : new Date(row.last_settlement_attempt_at).getTime(),
    }, nowMs)).map(row => ({
      roundId: String(row.round_id),
      startMs: Number(row.start_ms),
      expiryMs: Number(row.expiry_ms),
    }));
  } catch (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
}

/**
 * Atomically claims one already-observed expired round for provider settlement
 * polling. Claim before the network request so unresolved/API-error attempts
 * receive the same 30-second cooldown and cannot starve older due rounds.
 */
export async function markWaterxSettlementAttempt(
  intervalMinutes: WaterxInterval,
  roundId: string,
): Promise<boolean> {
  assertInterval(intervalMinutes);
  assertRoundId(roundId);
  if (!process.env.DATABASE_URL) return false;
  try {
    const { rows } = await pool.query(
      `UPDATE waterx_learning_rounds
          SET last_settlement_attempt_at=clock_timestamp()
        WHERE interval_minutes=$1 AND round_id=$2
          AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000)
          AND label_status IN ('unresolved','withheld') AND outcome IS NULL
          AND (last_settlement_attempt_at IS NULL OR
               last_settlement_attempt_at <= clock_timestamp()-interval '30 seconds')
        RETURNING round_id`,
      [intervalMinutes, roundId],
    );
    return rows.length > 0;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    return false;
  }
}

export type WaterxEvaluationRow = {
  roundId: string;
  startMs: number;
  expiryMs: number;
  observedAt: string;
  probabilityUp: number | null;
  outcome: "Up" | "Down" | null;
  settledAt: number | null;
  labelAvailableMs: number | null;
  labelStatus: string;
  withheldReason: string | null;
};

export function evaluateWaterxRows(intervalMinutes: WaterxInterval, inputRows: WaterxEvaluationRow[]) {
  assertInterval(intervalMinutes);
  const cadenceMs = intervalMinutes * 60_000;
  const ids = new Set<string>();
  for (const row of inputRows) {
    if (ids.has(row.roundId)) throw new Error(`Duplicate WaterX round ID in ${intervalMinutes}m evidence`);
    ids.add(row.roundId);
  }
  const rows = inputRows.filter(row => row.probabilityUp !== null &&
    Number.isFinite(row.probabilityUp) && row.probabilityUp >= 0 && row.probabilityUp <= 1 &&
    row.outcome !== null && row.labelStatus === "verified" &&
    row.settledAt !== null && row.settledAt > row.expiryMs &&
    row.labelAvailableMs !== null && Number.isFinite(row.labelAvailableMs))
    .sort((a, b) => a.startMs - b.startMs || a.roundId.localeCompare(b.roundId));
  const splitIndex = Math.floor(rows.length * 0.7);
  const testStart = rows[splitIndex]?.startMs ?? null;
  const training = testStart === null ? [] : rows.slice(0, splitIndex).filter(row =>
    Math.max(row.settledAt!, row.labelAvailableMs!) <= testStart - cadenceMs);
  const trainingIds = new Set(training.map(row => row.roundId));
  const test = rows.slice(splitIndex);
  const embargoed = rows.slice(0, splitIndex).filter(row => !trainingIds.has(row.roundId));
  const metric = (selected: WaterxEvaluationRow[]) => {
    if (!selected.length) return null;
    let brier = 0;
    let logLoss = 0;
    const bins = Array.from({ length: 10 }, (_, index) => ({
      lower: index / 10, upper: (index + 1) / 10, count: 0,
      predictedSum: 0, upCount: 0,
    }));
    for (const row of selected) {
      const p = row.probabilityUp!;
      const y = row.outcome === "Up" ? 1 : 0;
      brier += (p - y) ** 2;
      logLoss -= y * Math.log(Math.max(1e-12, p)) +
        (1 - y) * Math.log(Math.max(1e-12, 1 - p));
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.count++;
      bin.predictedSum += p;
      bin.upCount += y;
    }
    return {
      count: selected.length,
      brier: brier / selected.length,
      logLoss: logLoss / selected.length,
      calibration: bins.map(bin => ({
        lower: bin.lower,
        upper: bin.upper,
        count: bin.count,
        meanPredicted: bin.count ? bin.predictedSum / bin.count : null,
        observedUpRate: bin.count ? bin.upCount / bin.count : null,
      })),
    };
  };
  const eligibleSpanMs = rows.length > 1 ? rows.at(-1)!.startMs - rows[0].startMs : 0;
  const expectedSlots = eligibleSpanMs > 0 ? Math.floor(eligibleSpanMs / cadenceMs) + 1 : rows.length;
  const coveragePercent = expectedSlots ? Math.min(100, rows.length / expectedSlots * 100) : 0;
  const maxGapMs = rows.slice(1).reduce((maximum, row, index) =>
    Math.max(maximum, row.startMs - rows[index].startMs), 0);
  const minimumSpanMs = intervalMinutes === 5 ? 48 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
  const minimumCount = 300;
  const ready = rows.length >= minimumCount && eligibleSpanMs >= minimumSpanMs &&
    coveragePercent >= 50 && maxGapMs <= cadenceMs * 6 &&
    training.length >= 20 && test.length >= 20;
  return {
    protocol: "waterx-market-baseline-walk-forward-v1",
    intervalMinutes,
    status: ready ? "evaluated" : "insufficient",
    readiness: {
      ready,
      eligibleRounds: rows.length,
      minimumEligibleRounds: minimumCount,
      spanHours: Number((eligibleSpanMs / 3_600_000).toFixed(2)),
      minimumSpanHours: minimumSpanMs / 3_600_000,
      cadenceCoveragePercent: Number(coveragePercent.toFixed(2)),
      minimumCoveragePercent: 50,
      maximumGapMinutes: Number((maxGapMs / 60_000).toFixed(2)),
      maximumAllowedGapMinutes: intervalMinutes * 6,
    },
    split: {
      method: "Chronological 70/30 round-start split; both provider settlement and first app-observed label availability must precede test start by one full cadence.",
      trainingCount: training.length,
      embargoExcludedCount: embargoed.length,
      testCount: test.length,
      trainingObservedThrough: training.at(-1)?.observedAt ?? null,
      trainingLabelAvailableThroughMs: training.at(-1)?.labelAvailableMs ?? null,
      testObservedFrom: test[0]?.observedAt ?? null,
      testObservedThrough: test.at(-1)?.observedAt ?? null,
      testStartMs: testStart,
    },
    baseline: "Prospective frozen earliest pre-expiry WaterX market probability; evaluation only, not a promoted forecast.",
    trainingMetrics: metric(training),
    testMetrics: metric(test),
    promotedForecast: null,
    action: null,
    labelPolicy: "Only resolved WaterX settlements with confirmed matching anchors, actual settlePrice, matching TWAP outcome (equality is Up), and settledAt strictly after expiry are labeled. Training also requires the first app-observed accepted label timestamp.",
  };
}

function mapDbRow(row: any): WaterxEvaluationRow {
  return {
    roundId: String(row.round_id),
    startMs: Number(row.start_ms),
    expiryMs: Number(row.expiry_ms),
    observedAt: new Date(row.observed_at).toISOString(),
    probabilityUp: row.probability_up === null ? null : Number(row.probability_up),
    outcome: row.outcome === "Up" || row.outcome === "Down" ? row.outcome : null,
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    labelAvailableMs: row.label_status === "verified" && row.settlement_observed_at
      ? new Date(row.settlement_observed_at).getTime() : null,
    labelStatus: String(row.label_status),
    withheldReason: row.withheld_reason ?? null,
  };
}

export async function getWaterxLearning(intervalMinutes: WaterxInterval): Promise<Record<string, unknown>> {
  assertInterval(intervalMinutes);
  if (!process.env.DATABASE_URL) return unavailable("DATABASE_URL is not configured; WaterX learning is inactive.");
  try {
    const { rows } = await pool.query(
      `SELECT round_id,start_ms,expiry_ms,observed_at,probability_up,outcome,settled_at,
              settlement_observed_at,label_status,withheld_reason
         FROM waterx_learning_rounds WHERE interval_minutes=$1 ORDER BY start_ms ASC LIMIT 20000`,
      [intervalMinutes],
    );
    const evaluated = evaluateWaterxRows(intervalMinutes, rows.map(mapDbRow));
    return {
      ...evaluated,
      intervalIdentity: `${intervalMinutes}m`,
      evidenceCount: rows.length,
      withheldLabels: rows.filter(row => row.label_status === "withheld").length,
      latestObservationAt: rows.length ? new Date(rows.at(-1).observed_at).toISOString() : null,
    };
  } catch (error) {
    if (isMissingSchema(error)) return unavailable();
    throw error;
  }
}

export async function getWaterxHistory(
  intervalMinutes: WaterxInterval, limit = 100,
): Promise<Record<string, unknown>> {
  assertInterval(intervalMinutes);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("history limit must be a positive integer");
  const boundedLimit = Math.min(limit, 1000);
  if (!process.env.DATABASE_URL) return unavailable("DATABASE_URL is not configured; WaterX learning is inactive.");
  try {
    const { rows } = await pool.query(
      `SELECT interval_minutes,round_id,start_ms,expiry_ms,anchor_price,anchor_confirmed,
              probability_up,observed_at,source_proof,label_status,withheld_reason,
              settlement_anchor_price,settle_price,outcome,settled_at,
              settlement_observed_at,settlement_evidence
         FROM waterx_learning_rounds WHERE interval_minutes=$1
        ORDER BY start_ms DESC,round_id DESC LIMIT $2`,
      [intervalMinutes, boundedLimit],
    );
    return {
      status: "ok",
      intervalIdentity: `${intervalMinutes}m`,
      rows: rows.map(row => ({
        intervalMinutes: Number(row.interval_minutes),
        roundId: row.round_id,
        startMs: Number(row.start_ms),
        expiryMs: Number(row.expiry_ms),
        anchorPrice: row.anchor_price === null ? null : Number(row.anchor_price),
        anchorConfirmed: row.anchor_confirmed,
        probabilityUp: row.probability_up === null ? null : Number(row.probability_up),
        observedAt: new Date(row.observed_at).toISOString(),
        sourceProof: row.source_proof,
        labelStatus: row.label_status,
        withheldReason: row.withheld_reason,
        settlementAnchorPrice: row.settlement_anchor_price === null
          ? null : Number(row.settlement_anchor_price),
        settlePrice: row.settle_price === null ? null : Number(row.settle_price),
        outcome: row.outcome,
        settledAt: row.settled_at === null ? null : Number(row.settled_at),
        labelAvailableAt: row.settlement_observed_at
          ? new Date(row.settlement_observed_at).toISOString() : null,
        settlementObservedAt: row.settlement_observed_at
          ? new Date(row.settlement_observed_at).toISOString() : null,
        settlementEvidence: row.settlement_evidence,
      })),
    };
  } catch (error) {
    if (isMissingSchema(error)) return unavailable();
    throw error;
  }
}

/** Read-only settlement queue and provider-to-acceptance lag, split by market duration. */
export async function getWaterxSettlementHealth(intervalMinutes: WaterxInterval) {
  assertInterval(intervalMinutes);
  if (!process.env.DATABASE_URL) return { status: "unavailable", reason: "Database not configured." };
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS observed_rounds,
              count(*) FILTER (WHERE label_status='verified')::int AS accepted_labels,
              count(*) FILTER (WHERE label_status IN ('unresolved','withheld')
                AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000))::int AS pending_count,
              count(*) FILTER (WHERE label_status='withheld')::int AS withheld_count,
              min(expiry_ms) FILTER (WHERE label_status IN ('unresolved','withheld')
                AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000)) AS oldest_pending_expiry_ms,
              max(observed_at) AS last_observation_at,
              max(settlement_observed_at) AS last_accepted_label_at,
              count(*) FILTER (WHERE settled_at IS NOT NULL AND settlement_observed_at IS NOT NULL)::int AS latency_samples,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY
                extract(epoch FROM settlement_observed_at)*1000 - settled_at)
                FILTER (WHERE settled_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY
                extract(epoch FROM settlement_observed_at)*1000 - settled_at)
                FILTER (WHERE settled_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p95_ms,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY
                extract(epoch FROM settlement_observed_at)*1000 - settled_at)
                FILTER (WHERE settled_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p99_ms
         FROM waterx_learning_rounds WHERE interval_minutes=$1`,
      [intervalMinutes],
    );
    const row = rows[0];
    return {
      status: "ok", intervalMinutes, observedRounds: Number(row.observed_rounds),
      acceptedLabels: Number(row.accepted_labels), pendingCount: Number(row.pending_count),
      withheldCount: Number(row.withheld_count),
      oldestPendingExpiryMs: row.oldest_pending_expiry_ms === null ? null : Number(row.oldest_pending_expiry_ms),
      lastObservationAt: row.last_observation_at ? new Date(row.last_observation_at).toISOString() : null,
      lastAcceptedLabelAt: row.last_accepted_label_at ? new Date(row.last_accepted_label_at).toISOString() : null,
      acceptanceLatency: {
        sampleCount: Number(row.latency_samples),
        p50Ms: row.acceptance_p50_ms === null ? null : Number(row.acceptance_p50_ms),
        p95Ms: row.acceptance_p95_ms === null ? null : Number(row.acceptance_p95_ms),
        p99Ms: row.acceptance_p99_ms === null ? null : Number(row.acceptance_p99_ms),
        note: "Provider-reported settlement timestamp to first accepted app observation; provider and server clocks may differ.",
      },
    };
  } catch (error) {
    if (isMissingSchema(error)) return { status: "unavailable", reason: "WaterX learning schema unavailable." };
    throw error;
  }
}