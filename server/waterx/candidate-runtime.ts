import pg from "pg";
import {
  predictWaterxCandidate,
  WATERX_CANDIDATE_FEATURE_SCHEMA,
  WATERX_CANDIDATE_ARTIFACT_VERSION,
  WATERX_CANDIDATE_CALIBRATION_VERSION,
  trainWaterxCandidate,
  type WaterxCandidateInterval,
  type WaterxCandidateModelArtifact,
  type WaterxProspectiveCandidatePrediction,
  type WaterxCandidateTrainingReport,
  type WaterxProspectiveRoundRecord,
} from "./candidate-training";

const MAX_SOURCE_GAP_MS = 15_000;
const LOOKBACK_MS = 3 * 60_000;

type QueryResult = { rows: Array<Record<string, any>>; rowCount?: number | null };
export type WaterxCandidateQueryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
};

export type CoinbaseCandidateTick = Readonly<{
  archiveId: string;
  source: "Coinbase";
  sourceAtMs: number;
  receivedAtMs: number;
  price: number;
}>;

export type WaterxCandidateCaptureInput = Readonly<{
  intervalMinutes: WaterxCandidateInterval;
  roundId: string;
  source: "WaterX";
  startMs: number;
  expiryMs: number;
  predictionAtMs: number;
  confirmedAnchorPrice: number;
  anchorConfirmed: true;
  marketProbabilityUp: number;
  /** Server observation time, not a provider-created odds timestamp. */
  marketProbabilityObservedAtMs: number;
  /** App-observed odds from the immutable, persisted first WaterX round observation. */
  marketProbabilitySnapshot: Readonly<{
    storage: "waterx_learning_rounds";
    intervalMinutes: WaterxCandidateInterval;
    roundId: string;
    probabilityUp: number;
    appObservedAtMs: number;
    frozen: true;
  }>;
  firstFrozenMarketProbabilityUp: number;
  firstFrozenMarketProbabilityAtMs: number;
  comparisonArchive: Readonly<{
    source: "Coinbase";
    archiveSource: "coinbase_ticks";
    status: "available" | "partial" | "unavailable";
    truncated: boolean;
    requestedStartMs: number;
    requestedEndMs: number;
    ticks: readonly CoinbaseCandidateTick[];
  }>;
}>;

export type WaterxCandidateCaptureResult =
  | Readonly<{ status: "captured"; record: WaterxProspectiveRoundRecord }>
  | Readonly<{ status: "duplicate"; reason: string }>
  | Readonly<{ status: "skipped"; reason: string }>;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
}) as unknown as WaterxCandidateQueryable;

function isMissingSchema(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ["42P01", "3F000", "42703"].includes(String((error as { code?: unknown }).code ?? ""));
}

function throwSchemaError(error: unknown): never {
  if (isMissingSchema(error))
    throw new Error("Required WaterX learning/candidate schema is missing; apply the development-only WaterX learning, comparison-tick, and candidate migrations.");
  throw error;
}

function validateIdentity(input: WaterxCandidateCaptureInput): string | null {
  if (input.source !== "WaterX" || input.anchorConfirmed !== true)
    return "A confirmed WaterX round and anchor are required.";
  if (input.intervalMinutes !== 5 && input.intervalMinutes !== 15)
    return "WaterX candidate interval must be 5 or 15 minutes.";
  if (typeof input.roundId !== "string" || !input.roundId.trim())
    return "WaterX round ID is required.";
  if (![input.startMs, input.expiryMs, input.predictionAtMs].every(Number.isSafeInteger) ||
      input.startMs <= 0 || input.expiryMs - input.startMs !== input.intervalMinutes * 60_000 ||
      input.predictionAtMs < input.startMs || input.predictionAtMs >= input.expiryMs)
    return "Round identity timestamps are invalid or prediction is not pre-expiry.";
  if (!Number.isFinite(input.confirmedAnchorPrice) || input.confirmedAnchorPrice <= 0)
    return "Confirmed WaterX anchor price must be positive.";
  if (!Number.isFinite(input.marketProbabilityUp) ||
      input.marketProbabilityUp < 0 || input.marketProbabilityUp > 1 ||
      !Number.isSafeInteger(input.marketProbabilityObservedAtMs) ||
      input.marketProbabilityObservedAtMs > input.predictionAtMs)
    return "Market probability is invalid or lacks a pre-prediction app-observed timestamp.";
  const oddsSnapshot = input.marketProbabilitySnapshot;
  if (oddsSnapshot.storage !== "waterx_learning_rounds" || oddsSnapshot.frozen !== true ||
      oddsSnapshot.intervalMinutes !== input.intervalMinutes ||
      oddsSnapshot.roundId !== input.roundId ||
      oddsSnapshot.probabilityUp !== input.marketProbabilityUp ||
      oddsSnapshot.appObservedAtMs !== input.marketProbabilityObservedAtMs)
    return "Market odds do not match the explicitly identified immutable WaterX round snapshot.";
  if (!Number.isFinite(input.firstFrozenMarketProbabilityUp) ||
      input.firstFrozenMarketProbabilityUp < 0 || input.firstFrozenMarketProbabilityUp > 1 ||
      !Number.isSafeInteger(input.firstFrozenMarketProbabilityAtMs) ||
      input.firstFrozenMarketProbabilityAtMs > input.predictionAtMs ||
      input.firstFrozenMarketProbabilityAtMs < input.startMs)
    return "First frozen market probability is missing, invalid, or not pre-prediction.";
  if (input.firstFrozenMarketProbabilityUp !== input.marketProbabilityUp ||
      input.firstFrozenMarketProbabilityAtMs !== input.marketProbabilityObservedAtMs)
    return "Current odds differ from the persisted immutable first-frozen WaterX probability; revised in-round odds are not eligible.";
  return null;
}

function deriveSnapshot(input: WaterxCandidateCaptureInput):
  | { record: WaterxProspectiveRoundRecord; archiveEvidence: Record<string, unknown> }
  | { reason: string } {
  const identityError = validateIdentity(input);
  if (identityError) return { reason: identityError };
  const archive = input.comparisonArchive;
  const requiredStart = input.predictionAtMs - LOOKBACK_MS;
  if (archive.source !== "Coinbase" || archive.archiveSource !== "coinbase_ticks")
    return { reason: "Feature lookback requires provider-stamped Coinbase tick archive evidence; legacy comparisons are not eligible." };
  if (archive.status !== "available" || archive.truncated)
    return { reason: "Coinbase tick archive does not provide complete, untruncated lookback coverage." };
  if (archive.requestedStartMs > requiredStart || archive.requestedEndMs < input.predictionAtMs)
    return { reason: "Coinbase archive request does not cover the full three-minute pre-prediction window." };
  const ticks = [...archive.ticks].filter(tick =>
    tick.source === "Coinbase" &&
    Number.isSafeInteger(tick.sourceAtMs) &&
    Number.isSafeInteger(tick.receivedAtMs) &&
    tick.sourceAtMs <= input.predictionAtMs &&
    tick.receivedAtMs <= input.predictionAtMs &&
    Number.isFinite(tick.price) && tick.price > 0 && Boolean(tick.archiveId))
    .sort((a, b) => a.sourceAtMs - b.sourceAtMs ||
      a.archiveId.localeCompare(b.archiveId));
  if (ticks.length < 2)
    return { reason: "Too few valid pre-prediction Coinbase ticks cover the feature lookback." };
  const relevant = ticks.filter(tick => tick.sourceAtMs >= requiredStart - MAX_SOURCE_GAP_MS);
  if (!relevant.length || relevant[0].sourceAtMs > requiredStart ||
      requiredStart - relevant[0].sourceAtMs > MAX_SOURCE_GAP_MS)
    return { reason: "Coinbase tick observations do not reach the three-minute lookback boundary within the allowed gap." };
  const latest = relevant.at(-1)!;
  if (input.predictionAtMs - latest.sourceAtMs > MAX_SOURCE_GAP_MS)
    return { reason: "Latest Coinbase comparison tick is stale at prediction time." };
  for (let index = 1; index < relevant.length; index++) {
    if (relevant[index].sourceAtMs - relevant[index - 1].sourceAtMs > MAX_SOURCE_GAP_MS)
      return { reason: "Coinbase tick archive contains a gap exceeding the 15-second lookback bound." };
  }
  const priceAtOrBefore = (targetMs: number) => {
    const selected = [...relevant].reverse().find(tick => tick.sourceAtMs <= targetMs);
    if (!selected || targetMs - selected.sourceAtMs > MAX_SOURCE_GAP_MS) return null;
    return selected;
  };
  const oneMinute = priceAtOrBefore(input.predictionAtMs - 60_000);
  const threeMinute = priceAtOrBefore(requiredStart);
  if (!oneMinute || !threeMinute)
    return { reason: "Coinbase observations do not cover the one-minute and three-minute return boundaries within the allowed gap." };
  const return1m = latest.price / oneMinute.price - 1;
  const return3m = latest.price / threeMinute.price - 1;
  let squaredLogReturns = 0;
  for (let index = 1; index < relevant.length; index++) {
    const logReturn = Math.log(relevant[index].price / relevant[index - 1].price);
    squaredLogReturns += logReturn * logReturn;
  }
  const record: WaterxProspectiveRoundRecord = {
    intervalMinutes: input.intervalMinutes,
    roundId: input.roundId,
    source: "WaterX",
    featureSchema: WATERX_CANDIDATE_FEATURE_SCHEMA,
    frozen: true,
    startMs: input.startMs,
    expiryMs: input.expiryMs,
    predictionAtMs: input.predictionAtMs,
    featureSnapshotAtMs: input.predictionAtMs,
    confirmedAnchorPrice: input.confirmedAnchorPrice,
    marketProbabilityUp: input.marketProbabilityUp,
    features: {
      referenceDistanceBps: (latest.price / input.confirmedAnchorPrice - 1) * 10_000,
      timeRemainingFraction: (input.expiryMs - input.predictionAtMs) /
        (input.expiryMs - input.startMs),
      return1m,
      return3m,
      realizedVolatilityBps: Math.sqrt(squaredLogReturns) * 10_000,
      marketProbabilityUpDelta:
        input.marketProbabilityUp - input.firstFrozenMarketProbabilityUp,
      sourceAgeMs: input.predictionAtMs - latest.sourceAtMs,
    },
    label: null,
  };
  return {
    record,
    archiveEvidence: {
      source: archive.source,
      archiveSource: archive.archiveSource,
      requestedStartMs: archive.requestedStartMs,
      requestedEndMs: archive.requestedEndMs,
      selectedTicks: relevant.map(tick => ({
        archiveId: tick.archiveId,
        sourceAtMs: tick.sourceAtMs,
        receivedAtMs: tick.receivedAtMs,
        price: tick.price,
      })),
      firstFrozenMarketProbabilityUp: input.firstFrozenMarketProbabilityUp,
      firstFrozenMarketProbabilityAtMs: input.firstFrozenMarketProbabilityAtMs,
      marketProbabilityObservedAtMs: input.marketProbabilityObservedAtMs,
      marketProbabilitySnapshot: input.marketProbabilitySnapshot,
      marketProbabilityTimestampProvenance: "app-observed waterx_learning_rounds.observed_at; provider-created timestamp is not used",
    },
  };
}

function databaseTimestampMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

async function latestProspectiveCandidatePrediction(
  db: WaterxCandidateQueryable,
  intervalMinutes: WaterxCandidateInterval,
  record: WaterxProspectiveRoundRecord,
): Promise<WaterxProspectiveCandidatePrediction | null> {
  const { rows } = await db.query(
    `SELECT created_at,artifact
       FROM waterx_candidate_training_attempts
      WHERE interval_minutes=$1 AND status='candidate-evaluated'
        AND promoted=false AND artifact IS NOT NULL
        AND created_at < to_timestamp($2::double precision / 1000.0)
      ORDER BY created_at DESC,attempt_id DESC LIMIT 1`,
    [intervalMinutes, record.predictionAtMs],
  );
  const attempt = rows[0];
  if (!attempt) return null;
  const trainingAttemptAtMs = databaseTimestampMs(attempt.created_at);
  const artifact = (typeof attempt.artifact === "string"
    ? JSON.parse(attempt.artifact) : attempt.artifact) as WaterxCandidateModelArtifact;
  const probabilityUp = predictWaterxCandidate(artifact, record);
  if (probabilityUp === null || !Number.isFinite(trainingAttemptAtMs) ||
      trainingAttemptAtMs >= record.predictionAtMs ||
      artifact.artifactVersion !== WATERX_CANDIDATE_ARTIFACT_VERSION ||
      artifact.intervalMinutes !== intervalMinutes ||
      !/^[a-f\d]{64}$/i.test(artifact.datasetFingerprint) ||
      typeof artifact.modelVersion !== "string")
    return null;
  return {
    kind: "shadow-candidate",
    artifactVersion: WATERX_CANDIDATE_ARTIFACT_VERSION,
    modelVersion: artifact.modelVersion,
    datasetFingerprint: artifact.datasetFingerprint,
    calibrationVersion: WATERX_CANDIDATE_CALIBRATION_VERSION,
    probabilityUp,
    issuedAtMs: record.predictionAtMs,
    trainingAttemptAtMs,
  };
}

/**
 * Builds and inserts one immutable pre-expiry feature snapshot. A duplicate
 * interval/round key is reported, never updated or replaced.
 */
export async function captureWaterxCandidateSnapshot(
  input: WaterxCandidateCaptureInput,
  db: WaterxCandidateQueryable = pool,
): Promise<WaterxCandidateCaptureResult> {
  if (db === pool && !process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured; WaterX candidate snapshot was not persisted.");
  const derived = deriveSnapshot(input);
  if ("reason" in derived) return { status: "skipped", reason: derived.reason };
  try {
    const persisted = await db.query(
      `SELECT probability_up,observed_at,anchor_price,anchor_confirmed
         FROM waterx_learning_rounds
        WHERE interval_minutes=$1 AND round_id=$2`,
      [input.intervalMinutes, input.roundId],
    );
    const oddsRow = persisted.rows[0];
    if (!oddsRow || oddsRow.probability_up === null || oddsRow.probability_up === undefined)
      return { status: "skipped", reason: "No persisted first-frozen WaterX probability is available for this round." };
    const storedObservedAtMs = databaseTimestampMs(oddsRow.observed_at);
    if (oddsRow.anchor_confirmed !== true ||
        Number(oddsRow.anchor_price) !== input.confirmedAnchorPrice ||
        Number(oddsRow.probability_up) !== input.marketProbabilityUp ||
        storedObservedAtMs !== input.marketProbabilityObservedAtMs ||
        Number(oddsRow.probability_up) !== input.firstFrozenMarketProbabilityUp ||
        storedObservedAtMs !== input.firstFrozenMarketProbabilityAtMs)
      return {
        status: "skipped",
        reason: "Odds, app-observed time, and confirmed anchor do not match the persisted immutable first WaterX round observation.",
      };
    const candidatePrediction = await latestProspectiveCandidatePrediction(
      db, input.intervalMinutes, derived.record);
    const record: WaterxProspectiveRoundRecord = {
      ...derived.record,
      candidatePrediction,
    };
    const { rows } = await db.query(
      `WITH gate AS MATERIALIZED (
         SELECT clock_timestamp() < to_timestamp($4::double precision / 1000.0)
                  AS before_expiry
       ), inserted AS (
         INSERT INTO waterx_candidate_feature_snapshots
           (interval_minutes,round_id,start_ms,expiry_ms,prediction_at_ms,
            feature_snapshot_at_ms,confirmed_anchor_price,market_probability_up,
            feature_schema,record_data,source_evidence)
         SELECT $1,$2,$3,$4,$5,$5,$6,$7,$8,$9::jsonb,$10::jsonb
           FROM gate WHERE before_expiry
         ON CONFLICT (interval_minutes,round_id) DO NOTHING
         RETURNING interval_minutes
       )
       SELECT gate.before_expiry, inserted.interval_minutes IS NOT NULL AS inserted
         FROM gate LEFT JOIN inserted ON true`,
      [
        input.intervalMinutes, input.roundId, input.startMs, input.expiryMs,
        input.predictionAtMs, input.confirmedAnchorPrice, input.marketProbabilityUp,
        WATERX_CANDIDATE_FEATURE_SCHEMA, JSON.stringify(record),
        JSON.stringify({
          ...derived.archiveEvidence,
          candidatePrediction,
          candidatePredictionProvenance: candidatePrediction
            ? "previously persisted, interval-matched candidate artifact; captured before expiry"
            : "no eligible prior candidate artifact was available before prediction time",
        }),
      ],
    );
    const gate = rows[0];
    if (!gate)
      throw new Error("WaterX candidate snapshot insert gate returned no result.");
    if (gate.before_expiry !== true)
      return { status: "skipped", reason: "WaterX round expired before the database insert; no candidate snapshot was created." };
    return gate.inserted === true
      ? { status: "captured", record }
      : { status: "duplicate", reason: "An immutable feature snapshot already exists for this WaterX interval and round." };
  } catch (error) {
    return throwSchemaError(error);
  }
}

function mapTrainingRecord(row: Record<string, any>): WaterxProspectiveRoundRecord {
  const record = (typeof row.record_data === "string"
    ? JSON.parse(row.record_data) : row.record_data) as WaterxProspectiveRoundRecord;
  if (!row.outcome || !row.settlement_observed_at)
    return { ...record, label: null };
  const settledAtMs = Number(row.settled_at);
  const labelAvailableMs = row.settlement_observed_at instanceof Date
    ? row.settlement_observed_at.getTime()
    : new Date(row.settlement_observed_at).getTime();
  return {
    ...record,
    label: {
      source: "WaterX",
      acceptedByWaterxSettlementGate: true,
      resolutionStatus: "resolved",
      anchorConfirmed: true,
      settlementAnchorPrice: Number(row.settlement_anchor_price),
      settlePrice: Number(row.settle_price),
      outcome: row.outcome,
      settledAtMs,
      labelAvailableMs,
    },
  };
}

/**
 * Offline/scheduled candidate attempt. Reads only frozen snapshots and
 * currently verified WaterX accepted labels; it writes audit artifacts only.
 * No serving or promotion table is read or modified.
 */
export async function runWaterxCandidateTraining(
  db: WaterxCandidateQueryable = pool,
): Promise<readonly WaterxCandidateTrainingReport[]> {
  if (db === pool && !process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured; WaterX candidate training was not run.");
  try {
    const { rows } = await db.query(
      `SELECT s.record_data,l.settlement_anchor_price,l.settle_price,l.outcome,
              l.settled_at,l.settlement_observed_at
         FROM waterx_candidate_feature_snapshots s
         LEFT JOIN waterx_learning_rounds l
           ON l.interval_minutes=s.interval_minutes AND l.round_id=s.round_id
          AND l.label_status='verified' AND l.anchor_confirmed=true
          AND l.settlement_anchor_price=s.confirmed_anchor_price
          AND (l.settlement_quarantine IS NULL OR l.settlement_quarantine='[]'::jsonb)
          AND l.settled_at>s.expiry_ms AND l.settlement_observed_at IS NOT NULL
        ORDER BY s.interval_minutes,s.start_ms,s.round_id`,
    );
    const records = rows.map(mapTrainingRecord);
    const reports: WaterxCandidateTrainingReport[] = [];
    for (const intervalMinutes of [5, 15] as const) {
      const report = trainWaterxCandidate(intervalMinutes, records);
      await db.query(
        `INSERT INTO waterx_candidate_training_attempts
           (interval_minutes,dataset_hash,status,rejection_reason,report,artifact,promoted)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,false)`,
        [
          intervalMinutes, report.datasetFingerprint, report.status,
          report.rejectionReason, JSON.stringify(report),
          report.artifact === null ? null : JSON.stringify(report.artifact),
        ],
      );
      reports.push(report);
    }
    return reports;
  } catch (error) {
    return throwSchemaError(error);
  }
}