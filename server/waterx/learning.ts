import pg from "pg";
import { waterxObservedRoundCoverage } from "./coverage";
import {
  marketCaptureCoverage,
  marketProbabilityPredictionCoverage,
  settlementCompletionCoverage,
} from "./coverage";

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

type SettlementFacts = {
  resolutionStatus?: string | null;
  anchorPrice: number | null;
  anchorConfirmed: boolean;
  settlePrice: number | null;
  outcome: string | null;
  settledAt: number | null;
};

function resolvedSettlementFacts(value: unknown): SettlementFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const facts = value as Partial<SettlementFacts>;
  if (String(facts.resolutionStatus ?? "").trim().toLowerCase() !== "resolved" ||
      !normalizedOutcome(facts.outcome ?? null) ||
      facts.settlePrice === null || !Number.isFinite(facts.settlePrice) ||
      facts.settledAt === null || !Number.isFinite(facts.settledAt) ||
      facts.anchorPrice === null || !Number.isFinite(facts.anchorPrice) ||
      facts.anchorConfirmed !== true)
    return null;
  return {
    resolutionStatus: "resolved",
    anchorPrice: facts.anchorPrice!,
    anchorConfirmed: true,
    settlePrice: facts.settlePrice!,
    outcome: normalizedOutcome(facts.outcome!)!,
    settledAt: facts.settledAt!,
  };
}

function settlementFacts(input: WaterxSettlementInput): SettlementFacts {
  return {
    resolutionStatus: input.resolutionStatus,
    anchorPrice: input.anchorPrice,
    anchorConfirmed: input.anchorConfirmed,
    settlePrice: input.settlePrice,
    outcome: input.outcome,
    settledAt: input.settledAt,
  };
}

export function isWaterxSettlementObservation(input: WaterxSettlementInput): boolean {
  return input.settledAt !== null ||
    input.resolutionStatus?.trim().toLowerCase() === "resolved";
}

function sameSettlementFacts(left: SettlementFacts, right: SettlementFacts): boolean {
  const a = resolvedSettlementFacts(left);
  const b = resolvedSettlementFacts(right);
  return !!a && !!b && a.anchorPrice === b.anchorPrice &&
    a.settlePrice === b.settlePrice && a.outcome === b.outcome &&
    a.settledAt === b.settledAt;
}

export function waterxSettlementRevision(
  previousEvidence: unknown,
  proposed: WaterxSettlementInput,
): "same" | "contradictory" | "not-comparable" {
  const previous = resolvedSettlementFacts(previousEvidence);
  const current = resolvedSettlementFacts(settlementFacts(proposed));
  if (!previous || !current) return "not-comparable";
  return sameSettlementFacts(previous, current) ? "same" : "contradictory";
}

type WaterxSettlementDecision =
  | { kind: "rejected"; reason: string }
  | { kind: "accept" }
  | { kind: "same" }
  | { kind: "disputed" };

type WaterxStoredSettlement = {
  expiry_ms: number | string;
  anchor_price: string | number | null;
  anchor_confirmed: boolean;
  outcome: string | null;
  interval_minutes?: number;
  round_id?: string;
  initial_anchor_price?: string | number | null;
  initial_anchor_confirmed?: boolean | null;
  settlement_anchor_price?: string | number | null;
  settle_price?: string | number | null;
  settled_at?: number | string | null;
  settlement_evidence?: unknown;
  settlement_disputed?: boolean;
};

export function waterxSettlementDecision(
  input: WaterxSettlementInput,
  stored: WaterxStoredSettlement,
): WaterxSettlementDecision {
  // A valid differing final anchor conflicts with an accepted label and must
  // be quarantined rather than rejected as stale live-anchor evidence.
  const revisionRound = stored.outcome !== null
    ? { ...stored, anchor_price: input.anchorPrice, anchor_confirmed: true }
    : stored;
  const rejection = waterxSettlementRejection(input, { ...revisionRound, outcome: null });
  if (rejection) return { kind: "rejected", reason: rejection };
  if (stored.outcome === null) return { kind: "accept" };
  if (stored.settlement_disputed) return { kind: "disputed" };
  const acceptedEvidence = stored.settlement_evidence ?? {
    resolutionStatus: "resolved",
    anchorPrice: Number(stored.settlement_anchor_price ?? stored.anchor_price),
    anchorConfirmed: true,
    settlePrice: stored.settle_price === null || stored.settle_price === undefined
      ? null : Number(stored.settle_price),
    outcome: stored.outcome,
    settledAt: stored.settled_at === null || stored.settled_at === undefined
      ? null : Number(stored.settled_at),
  };
  return waterxSettlementRevision(acceptedEvidence, input) === "same"
    ? { kind: "same" } : { kind: "disputed" };
}

function settlementFactsChanged(previous: unknown, proposed: WaterxSettlementInput): boolean {
  if (previous === null || previous === undefined) return true;
  const before = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown> : {};
  const after = settlementFacts(proposed);
  return ["resolutionStatus", "anchorPrice", "anchorConfirmed", "settlePrice", "outcome", "settledAt"]
    .some(key => (before[key] ?? null) !== ((after as Record<string, unknown>)[key] ?? null));
}

function quarantineHasRevision(history: unknown, proposed: WaterxSettlementInput): boolean {
  return Array.isArray(history) && history.some(item =>
    waterxSettlementRevision(item, proposed) === "same");
}

type QueryResult = { rows: any[]; rowCount?: number | null };
export type WaterxQueryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect?(): Promise<{
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    release(): void;
  }>;
};
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 3,
  connectionTimeoutMillis: 5_000, query_timeout: 10_000, statement_timeout: 10_000,
}) as unknown as WaterxQueryable;

export function getWaterxObservedRoundCoverage() {
  return waterxObservedRoundCoverage(pool);
}

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
 * Preserve the first reference/proof/odds, allow only a same-window provisional
 * reference to upgrade, and retain later confirmed values independently.
 */
export const WATERX_ROUND_OBSERVATION_SQL = `INSERT INTO waterx_learning_rounds
  (interval_minutes,round_id,start_ms,expiry_ms,anchor_price,anchor_confirmed,
   initial_anchor_price,initial_anchor_confirmed,confirmed_anchor_observed_at,
   probability_up,observed_at,source_proof,label_status)
 VALUES ($1,$2,$3,$4,$5,$6,$5,$6,CASE WHEN $6 THEN $8::timestamptz ELSE NULL END,
         $7,$8,$9,'unresolved')
 ON CONFLICT (interval_minutes,round_id) DO UPDATE SET
   initial_anchor_price=CASE
     WHEN waterx_learning_rounds.initial_anchor_confirmed IS NULL
       THEN waterx_learning_rounds.anchor_price
     ELSE waterx_learning_rounds.initial_anchor_price END,
   initial_anchor_confirmed=COALESCE(
     waterx_learning_rounds.initial_anchor_confirmed,
     waterx_learning_rounds.anchor_confirmed),
   anchor_price=CASE
     WHEN NOT waterx_learning_rounds.anchor_confirmed AND EXCLUDED.anchor_confirmed
       THEN EXCLUDED.anchor_price
     ELSE waterx_learning_rounds.anchor_price END,
   anchor_confirmed=waterx_learning_rounds.anchor_confirmed OR EXCLUDED.anchor_confirmed,
   confirmed_anchor_observed_at=CASE
     WHEN NOT waterx_learning_rounds.anchor_confirmed AND EXCLUDED.anchor_confirmed
       THEN EXCLUDED.confirmed_anchor_observed_at
     ELSE waterx_learning_rounds.confirmed_anchor_observed_at END,
   probability_up=COALESCE(waterx_learning_rounds.probability_up,EXCLUDED.probability_up),
   observed_at=CASE WHEN waterx_learning_rounds.probability_up IS NULL
                          AND EXCLUDED.probability_up IS NOT NULL
                    THEN EXCLUDED.observed_at ELSE waterx_learning_rounds.observed_at END
 WHERE waterx_learning_rounds.start_ms=EXCLUDED.start_ms
   AND waterx_learning_rounds.expiry_ms=EXCLUDED.expiry_ms
 RETURNING interval_minutes,round_id`;

export const WATERX_REFERENCE_CONFIRMATION_SQL = `INSERT INTO waterx_research_reference_confirmations
  (interval_minutes,round_id,anchor_price,observed_at,source_evidence)
 VALUES ($1,$2,$3,$4,$5::jsonb)
 ON CONFLICT (interval_minutes,round_id,anchor_price) DO NOTHING`;

function referenceConfirmationEvidence(input: WaterxRoundInput) {
  return JSON.stringify({
    provider: "WaterX",
    evidenceKind: "authoritative confirmed round reference",
    roundId: input.roundId, startMs: input.startMs, expiryMs: input.expiryMs,
    source: input.source, observedAnchorPrice: input.anchorPrice,
    anchorConfirmed: input.anchorConfirmed,
  });
}

export async function recordWaterxRound(
  input: WaterxRoundInput,
  executor?: WaterxQueryable,
): Promise<boolean> {
  assertInterval(input.intervalMinutes);
  assertRoundId(input.roundId);
  if (input.source !== "WaterX") throw new Error("WaterX source proof is required");
  if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.expiryMs) ||
      input.startMs <= 0 || input.expiryMs <= input.startMs ||
      input.startMs % 1000 !== 0 || input.expiryMs % 1000 !== 0 ||
      input.expiryMs - input.startMs !== input.intervalMinutes * 60_000)
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
  if (!executor && !process.env.DATABASE_URL) return false;
  const dbExecutor = executor ?? pool;
  try {
    const client = await dbExecutor.connect?.();
    const db = client ?? dbExecutor;
    if (client) await db.query("BEGIN");
    try {
      const { rows } = await db.query(
        WATERX_ROUND_OBSERVATION_SQL,
       [input.intervalMinutes, input.roundId, input.startMs, input.expiryMs,
        input.anchorPrice, input.anchorConfirmed, input.probabilityUp,
         input.observedAt, referenceConfirmationEvidence(input)],
      );
      if (!rows[0]) {
        if (client) await db.query("COMMIT");
        return false;
      }
      if (input.anchorConfirmed) {
        await db.query(WATERX_REFERENCE_CONFIRMATION_SQL, [
          input.intervalMinutes, input.roundId, input.anchorPrice, input.observedAt,
          referenceConfirmationEvidence(input),
        ]);
      }
      if (client) await db.query("COMMIT");
      return true;
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original database error */ }
      }
      if (!isMissingSchema(error)) throw error;
      return false;
    } finally {
      client?.release();
    }
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    return false;
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
  interval_minutes?: number;
  round_id?: string;
  initial_anchor_price?: string | number | null;
  initial_anchor_confirmed?: boolean | null;
}): string | null {
  const expiryMs = Number(round.expiry_ms);
  const storedAnchor = round.anchor_price === null ? null : Number(round.anchor_price);
  if (round.interval_minutes !== undefined && round.interval_minutes !== input.intervalMinutes)
    return "Settlement interval does not match the WaterX round identity.";
  if (round.round_id !== undefined && round.round_id !== input.roundId)
    return "Settlement round ID does not match the WaterX round identity.";
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs))
    return "WaterX settlement observedAt is not a valid timestamp.";
  const nowMs = Date.now();
  if (observedAtMs > nowMs)
    return "WaterX settlement observedAt is in the future.";
  if (input.settledAt !== null && input.settledAt > nowMs)
    return "WaterX settledAt is in the future.";
  if (input.settledAt !== null && input.settledAt > observedAtMs)
    return "WaterX settledAt is later than the settlement observation.";
  if (input.resolutionStatus !== "resolved") return "WaterX resolutionStatus is not verified as resolved.";
  if (input.anchorConfirmed !== true || input.anchorPrice === null ||
      !Number.isFinite(input.anchorPrice) || input.anchorPrice <= 0)
    return "Final authoritative WaterX anchor is missing or unconfirmed.";
  const firstAnchorWasConfirmed = round.initial_anchor_confirmed ?? round.anchor_confirmed;
  if (firstAnchorWasConfirmed && storedAnchor !== input.anchorPrice)
    return "Final confirmed WaterX anchor contradicts an already confirmed round reference.";
  if (input.settlePrice === null || !Number.isFinite(input.settlePrice) || input.settlePrice <= 0)
    return "Actual WaterX settlePrice is missing or invalid.";
  const normalized = normalizedOutcome(input.outcome);
  if (!normalized) return "WaterX outcome is missing or is not Up/Down.";
  if (normalized !== waterxOutcomeForPrices(input.anchorPrice, input.settlePrice))
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
export async function recordWaterxSettlement(
  input: WaterxSettlementInput,
  executor?: WaterxQueryable,
): Promise<boolean> {
  assertInterval(input.intervalMinutes);
  assertRoundId(input.roundId);
  finiteOrNull("anchorPrice", input.anchorPrice);
  finiteOrNull("settlePrice", input.settlePrice);
  if (input.settledAt !== null && !Number.isFinite(input.settledAt))
    throw new Error("settledAt must be finite or null");
  validObservedAt(input.observedAt);
  if (!executor && !process.env.DATABASE_URL) return false;
  const dbExecutor = executor ?? pool;
  let client: Awaited<ReturnType<NonNullable<WaterxQueryable["connect"]>>> | null = null;
  try {
    client = dbExecutor.connect ? await dbExecutor.connect() : null;
    const db = client ?? dbExecutor;
    if (client) await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT interval_minutes,round_id,start_ms,expiry_ms,anchor_price,
              anchor_confirmed,initial_anchor_price,initial_anchor_confirmed,
              confirmed_anchor_observed_at,outcome,settle_price,
              settlement_anchor_price,settled_at,settlement_evidence,
              settlement_evidence_history,settlement_quarantine,
              settlement_disputed,settlement_disputed_reason
         FROM waterx_learning_rounds
        WHERE interval_minutes=$1 AND round_id=$2 FOR UPDATE`,
      [input.intervalMinutes, input.roundId],
    );
    if (!rows[0]) {
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(false, false);
    }
    const evidence = {
      source: "WaterX",
      resolutionStatus: input.resolutionStatus ?? null,
      anchorPrice: input.anchorPrice,
      anchorConfirmed: input.anchorConfirmed,
      settlePrice: input.settlePrice,
      outcome: input.outcome,
      settledAt: input.settledAt,
      observedAt: input.observedAt,
      accepted: false,
    };
    const previousEvidence = rows[0].settlement_evidence ?? (rows[0].outcome !== null ? {
      resolutionStatus: "resolved",
      anchorPrice: Number(rows[0].settlement_anchor_price ?? rows[0].anchor_price),
      anchorConfirmed: true,
      settlePrice: rows[0].settle_price === null ? null : Number(rows[0].settle_price),
      outcome: rows[0].outcome,
      settledAt: rows[0].settled_at === null ? null : Number(rows[0].settled_at),
    } : null);
    const decision = waterxSettlementDecision(input, {
      ...rows[0],
      settlement_evidence: previousEvidence,
    });
    if (decision.kind === "same") {
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(true, !rows[0].settlement_disputed);
    }
    if (decision.kind === "disputed") {
      if (!quarantineHasRevision(rows[0].settlement_quarantine, input)) {
        const originalEvidence = previousEvidence ?? {
          source: "WaterX",
          resolutionStatus: "resolved",
          anchorPrice: rows[0].settlement_anchor_price ?? rows[0].anchor_price,
          anchorConfirmed: true,
          settlePrice: rows[0].settle_price,
          outcome: rows[0].outcome,
          settledAt: rows[0].settled_at === null ? null : Number(rows[0].settled_at),
          accepted: true,
        };
        await db.query(
          `UPDATE waterx_learning_rounds SET
             settlement_first_observed_at=CASE WHEN $6
               THEN COALESCE(settlement_first_observed_at,$3) ELSE settlement_first_observed_at END,
             provider_settlement_at=COALESCE(provider_settlement_at,$5),
             settlement_disputed=true,
             settlement_disputed_reason=COALESCE(settlement_disputed_reason,
               'A valid provider settlement revision conflicts with the frozen accepted label.'),
             label_status='withheld',
             withheld_reason=COALESCE(withheld_reason,
               'Disputed provider settlement revision; original accepted label retained for audit.'),
             settlement_evidence_history=COALESCE(settlement_evidence_history,'[]'::jsonb)
               || jsonb_build_array($4::jsonb,$7::jsonb),
             settlement_quarantine=COALESCE(settlement_quarantine,'[]'::jsonb)
               || jsonb_build_array($4::jsonb,$7::jsonb)
           WHERE interval_minutes=$1 AND round_id=$2`,
          [input.intervalMinutes, input.roundId, input.observedAt,
           JSON.stringify(originalEvidence), input.settledAt,
           isWaterxSettlementObservation(input), JSON.stringify({ ...evidence, quarantined: true })],
        );
      }
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(true, false);
    }
    const rejection = decision.kind === "rejected" ? decision.reason : null;
    const accepted = decision.kind === "accept";
    if (!accepted && !rejection)
      throw new Error("Unexpected WaterX settlement decision");
    const appendHistory = settlementFactsChanged(previousEvidence, input);
    if (!accepted && rows[0].outcome !== null) {
      if (appendHistory) {
        await db.query(
          `UPDATE waterx_learning_rounds SET
             settlement_first_observed_at=CASE WHEN $6
               THEN COALESCE(settlement_first_observed_at,$3) ELSE settlement_first_observed_at END,
             provider_settlement_at=COALESCE(provider_settlement_at,$5),
             settlement_evidence_history=COALESCE(settlement_evidence_history,'[]'::jsonb)
               || jsonb_build_array($4::jsonb)
           WHERE interval_minutes=$1 AND round_id=$2`,
          [input.intervalMinutes, input.roundId, input.observedAt,
           JSON.stringify({ ...evidence, rejection }), input.settledAt,
           isWaterxSettlementObservation(input)],
        );
      }
      if (client) await db.query("COMMIT");
      return waterxSettlementResult(true, false);
    }
    const acceptedAtMs = firstAcceptedWaterxLabelAvailableMs(
      null, accepted, Date.parse(input.observedAt));
    const acceptedAt = acceptedAtMs === null ? null : new Date(acceptedAtMs).toISOString();
    await db.query(
      `UPDATE waterx_learning_rounds SET
         settlement_first_observed_at=CASE WHEN $13
           THEN COALESCE(settlement_first_observed_at,$3) ELSE settlement_first_observed_at END,
          first_verified_at=CASE WHEN outcome IS NULL AND $7
            THEN COALESCE(first_verified_at,$6) ELSE first_verified_at END,
         provider_settlement_at=COALESCE(provider_settlement_at,$12),
         settlement_evidence_history=CASE WHEN $5
           THEN COALESCE(settlement_evidence_history,'[]'::jsonb) || jsonb_build_array($4::jsonb)
           ELSE COALESCE(settlement_evidence_history,'[]'::jsonb) END,
         settlement_evidence=CASE WHEN outcome IS NOT NULL THEN settlement_evidence ELSE $4::jsonb END,
        settlement_observed_at=CASE WHEN outcome IS NOT NULL THEN settlement_observed_at
                                    WHEN $7 THEN COALESCE(settlement_observed_at,$6) ELSE NULL END,
         label_status=CASE WHEN outcome IS NOT NULL THEN label_status
                           WHEN $7 THEN 'verified' ELSE 'withheld' END,
         withheld_reason=CASE WHEN outcome IS NOT NULL THEN withheld_reason
                              WHEN $7 THEN NULL ELSE $8 END,
          anchor_price=CASE WHEN outcome IS NULL AND $7 AND NOT anchor_confirmed
                            THEN $9 ELSE anchor_price END,
          anchor_confirmed=CASE WHEN outcome IS NULL AND $7 AND NOT anchor_confirmed
                                THEN true ELSE anchor_confirmed END,
          confirmed_anchor_observed_at=CASE
            WHEN outcome IS NULL AND $7 AND NOT anchor_confirmed
              THEN COALESCE(confirmed_anchor_observed_at,$3)
            ELSE confirmed_anchor_observed_at END,
         settlement_anchor_price=CASE WHEN outcome IS NULL AND $7 THEN $9
                                      ELSE settlement_anchor_price END,
         settle_price=CASE WHEN outcome IS NULL AND $7 THEN $10 ELSE settle_price END,
         outcome=CASE WHEN outcome IS NULL AND $7 THEN $11 ELSE outcome END,
         settled_at=CASE WHEN outcome IS NULL AND $7 THEN $12 ELSE settled_at END
       WHERE interval_minutes=$1 AND round_id=$2`,
       [input.intervalMinutes, input.roundId, input.observedAt,
         JSON.stringify({ ...evidence, accepted }), appendHistory,
         acceptedAt, accepted, rejection ?? null, input.anchorPrice,
         input.settlePrice, normalizedOutcome(input.outcome), input.settledAt,
         isWaterxSettlementObservation(input)],
    );
     if (accepted && input.anchorPrice !== null) {
       await db.query(WATERX_REFERENCE_CONFIRMATION_SQL, [
         input.intervalMinutes, input.roundId, input.anchorPrice, input.observedAt,
         JSON.stringify({
           provider: "WaterX",
           evidenceKind: "verified authoritative settlement anchor",
           roundId: input.roundId,
           finalAnchorPrice: input.anchorPrice,
           settlementOutcome: normalizedOutcome(input.outcome),
           settlePrice: input.settlePrice,
           settledAt: input.settledAt,
           observedAt: input.observedAt,
         }),
       ]);
     }
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
    // Old unresolved archive rows must not postpone scoring a newly frozen
    // research choice for an entire archive-retry cycle. This is optional
    // until the reviewed additive schema is installed; legacy reads still work.
    const schema = await pool.query(
      "SELECT to_regclass('waterx_research_choices')::text AS research",
    );
    const researchPriority = schema.rows[0]?.research
      ? `EXISTS (SELECT 1 FROM waterx_research_choices c
          WHERE c.interval_minutes=waterx_learning_rounds.interval_minutes
            AND c.round_id=waterx_learning_rounds.round_id AND c.state='FROZEN'
            AND c.start_ms=waterx_learning_rounds.start_ms
            AND c.expiry_ms=waterx_learning_rounds.expiry_ms) DESC,`
      : "";
    const { rows } = await pool.query(
      `SELECT round_id,start_ms,expiry_ms,label_status,outcome,last_settlement_attempt_at
         FROM waterx_learning_rounds
        WHERE interval_minutes=$1 AND expiry_ms < $2
          AND label_status IN ('unresolved','withheld') AND outcome IS NULL
          AND (last_settlement_attempt_at IS NULL OR
               last_settlement_attempt_at <= to_timestamp($2::double precision/1000)-interval '30 seconds')
         ORDER BY ${researchPriority} last_settlement_attempt_at ASC NULLS FIRST,expiry_ms ASC,round_id ASC
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
    labelAvailableMs: row.label_status === "verified" && !row.settlement_disputed &&
      row.settlement_observed_at
      ? new Date(row.settlement_observed_at).getTime() : null,
    labelStatus: row.settlement_disputed ? "disputed" : String(row.label_status),
    withheldReason: row.settlement_disputed
      ? row.settlement_disputed_reason ?? "Accepted settlement is disputed."
      : row.withheld_reason ?? null,
  };
}

export async function getWaterxLearning(intervalMinutes: WaterxInterval): Promise<Record<string, unknown>> {
  assertInterval(intervalMinutes);
  if (!process.env.DATABASE_URL) return unavailable("DATABASE_URL is not configured; WaterX learning is inactive.");
  try {
    const { rows } = await pool.query(
      `SELECT round_id,start_ms,expiry_ms,observed_at,probability_up,outcome,settled_at,
              settlement_observed_at,label_status,withheld_reason,
              settlement_disputed,settlement_disputed_reason
         FROM waterx_learning_rounds WHERE interval_minutes=$1 ORDER BY start_ms ASC LIMIT 20000`,
      [intervalMinutes],
    );
    const evaluated = evaluateWaterxRows(intervalMinutes, rows.map(mapDbRow));
    return {
      ...evaluated,
      intervalIdentity: `${intervalMinutes}m`,
      evidenceCount: rows.length,
      withheldLabels: rows.filter(row =>
        row.label_status === "withheld" && !row.settlement_disputed).length,
      disputedLabels: rows.filter(row => row.settlement_disputed).length,
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
              provider_settlement_at,settlement_first_observed_at,settlement_observed_at,settlement_evidence,
              settlement_evidence_history,settlement_quarantine,
              settlement_disputed,settlement_disputed_reason
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
        labelStatus: row.settlement_disputed ? "disputed" : row.label_status,
        withheldReason: row.settlement_disputed
          ? row.settlement_disputed_reason ?? "Accepted settlement is disputed."
          : row.withheld_reason,
        settlementDisputed: row.settlement_disputed,
        settlementAnchorPrice: row.settlement_anchor_price === null
          ? null : Number(row.settlement_anchor_price),
        settlePrice: row.settle_price === null ? null : Number(row.settle_price),
        outcome: row.outcome,
        settledAt: row.settled_at === null ? null : Number(row.settled_at),
        providerSettledAt: row.provider_settlement_at === null
          ? null : Number(row.provider_settlement_at),
        settlementFirstObservedAt: row.settlement_first_observed_at
          ? new Date(row.settlement_first_observed_at).toISOString() : null,
        labelAvailableAt: row.settlement_observed_at
          ? new Date(row.settlement_observed_at).toISOString() : null,
        settlementObservedAt: row.settlement_observed_at
          ? new Date(row.settlement_observed_at).toISOString() : null,
        settlementEvidence: row.settlement_evidence,
        settlementEvidenceHistory: row.settlement_evidence_history,
        settlementQuarantine: row.settlement_quarantine,
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
      `SELECT count(DISTINCT round_id)::int AS observed_rounds,
              count(DISTINCT start_ms)::int AS observed_round_starts,
              min(start_ms) AS first_observed_round_start_ms,
              floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS as_of_ms,
              count(DISTINCT round_id) FILTER (
                WHERE expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000))::int AS expired_rounds,
              count(DISTINCT round_id) FILTER (
                WHERE label_status='verified' AND NOT settlement_disputed
                  AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000)
                  AND settled_at > expiry_ms AND outcome IS NOT NULL)::int AS accepted_labels,
              count(DISTINCT round_id) FILTER (
                WHERE label_status='verified' AND NOT settlement_disputed
                  AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000)
                  AND settled_at > expiry_ms AND outcome IS NOT NULL
                  AND probability_up BETWEEN 0 AND 1
                  AND observed_at <= to_timestamp(expiry_ms::double precision / 1000.0))::int
                  AS scored_market_probability_rounds,
              count(*) FILTER (WHERE settlement_disputed)::int AS disputed_count,
              count(*) FILTER (WHERE label_status IN ('unresolved','withheld')
                AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000))::int AS pending_count,
              count(*) FILTER (WHERE label_status='withheld' AND NOT settlement_disputed)::int AS withheld_count,
              min(expiry_ms) FILTER (WHERE label_status IN ('unresolved','withheld')
                AND expiry_ms < floor(extract(epoch FROM clock_timestamp())*1000)) AS oldest_pending_expiry_ms,
              max(observed_at) AS last_observation_at,
               max(settlement_first_observed_at) AS last_settlement_first_observed_at,
              max(settlement_observed_at) AS last_accepted_label_at,
              min(settlement_first_observed_at) FILTER
                (WHERE provider_settlement_at IS NOT NULL) AS first_settlement_latency_observation_at,
              max(settlement_first_observed_at) FILTER
                (WHERE provider_settlement_at IS NOT NULL) AS last_settlement_latency_observation_at,
               count(*) FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_observed_at IS NOT NULL)::int AS latency_samples,
               count(*) FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL)::int AS first_observation_latency_samples,
                count(*) FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                  AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at < 0)::int
                  AS first_observation_clock_uncertain_samples,
                count(*) FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                  AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at >= 0
                  AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at
                    <= $1 * 60000)::int AS first_observation_within_interval_samples,
                count(*) FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                  AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at
                    > $1 * 60000)::int AS first_observation_delayed_discovery_samples,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY
                  extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                  FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at >= 0
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at <= $1 * 60000)
                    AS within_interval_first_observation_p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY
                  extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                  FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at >= 0
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at <= $1 * 60000)
                    AS within_interval_first_observation_p95_ms,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY
                  extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                  FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at > $1 * 60000)
                    AS delayed_first_observation_p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY
                  extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                  FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL
                    AND extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at > $1 * 60000)
                    AS delayed_first_observation_p95_ms,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL) AS first_observation_p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL) AS first_observation_p95_ms,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_first_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_first_observed_at IS NOT NULL) AS first_observation_p99_ms,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p95_ms,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY
                 extract(epoch FROM settlement_observed_at)*1000 - provider_settlement_at)
                 FILTER (WHERE provider_settlement_at IS NOT NULL AND settlement_observed_at IS NOT NULL) AS acceptance_p99_ms
         FROM waterx_learning_rounds WHERE interval_minutes=$1`,
      [intervalMinutes],
    );
    const row = rows[0];
    const captureCoverage = marketCaptureCoverage(
      intervalMinutes,
      Number(row.observed_round_starts),
      row.first_observed_round_start_ms === null
        ? null : Number(row.first_observed_round_start_ms),
      Number(row.as_of_ms),
    );
    const settlementCompletion = settlementCompletionCoverage(
      Number(row.accepted_labels), Number(row.expired_rounds),
    );
    const predictionCoverage = marketProbabilityPredictionCoverage(
      Number(row.scored_market_probability_rounds), Number(row.accepted_labels),
    );
    return {
      status: "ok", settlementStatus: Number(row.pending_count) > 0
        ? "SETTLEMENT_PENDING" : "NO_PENDING_SETTLEMENT",
      intervalMinutes, observedRounds: Number(row.observed_rounds),
      acceptedLabels: Number(row.accepted_labels), pendingCount: Number(row.pending_count),
      disputedLabels: Number(row.disputed_count),
      marketCaptureCoverage: captureCoverage,
      settlementCompletion,
      predictionCoverage,
      // Preserve the existing key for consumers, but do not report a false 0%
      // when there are no expired observed rounds eligible for settlement.
      labelCoveragePercent: settlementCompletion.percent,
      withheldCount: Number(row.withheld_count),
      oldestPendingExpiryMs: row.oldest_pending_expiry_ms === null ? null : Number(row.oldest_pending_expiry_ms),
      lastObservationAt: row.last_observation_at ? new Date(row.last_observation_at).toISOString() : null,
      lastSettlementFirstObservedAt: row.last_settlement_first_observed_at
        ? new Date(row.last_settlement_first_observed_at).toISOString() : null,
      lastAcceptedLabelAt: row.last_accepted_label_at ? new Date(row.last_accepted_label_at).toISOString() : null,
      providerToFirstObservationLatency: {
        sampleCount: Number(row.first_observation_latency_samples),
        p50Ms: row.first_observation_p50_ms === null ? null : Number(row.first_observation_p50_ms),
        p95Ms: row.first_observation_p95_ms === null ? null : Number(row.first_observation_p95_ms),
        p99Ms: row.first_observation_p99_ms === null ? null : Number(row.first_observation_p99_ms),
        note: "Provider-reported settlement timestamp to first app observation; negative values can reflect clock uncertainty.",
      },
      settlementDiscoveryLatencyByTiming: {
        intervalMinutes,
        observationWindow: {
          firstObservedAt: row.first_settlement_latency_observation_at
            ? new Date(row.first_settlement_latency_observation_at).toISOString() : null,
          lastObservedAt: row.last_settlement_latency_observation_at
            ? new Date(row.last_settlement_latency_observation_at).toISOString() : null,
          basis: "All retained interval rows; this is not a fixed rolling window.",
        },
        clockUncertainSampleCount: Number(row.first_observation_clock_uncertain_samples),
        withinInterval: {
          sampleCount: Number(row.first_observation_within_interval_samples),
          p50Ms: row.within_interval_first_observation_p50_ms === null
            ? null : Number(row.within_interval_first_observation_p50_ms),
          p95Ms: row.within_interval_first_observation_p95_ms === null
            ? null : Number(row.within_interval_first_observation_p95_ms),
        },
        delayedDiscovery: {
          sampleCount: Number(row.first_observation_delayed_discovery_samples),
          p50Ms: row.delayed_first_observation_p50_ms === null
            ? null : Number(row.delayed_first_observation_p50_ms),
          p95Ms: row.delayed_first_observation_p95_ms === null
            ? null : Number(row.delayed_first_observation_p95_ms),
          note: "Provider-reported settlement first seen more than one market interval later. May reflect retry or recovery, but stored evidence does not identify backfill or restart as the cause.",
        },
      },
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