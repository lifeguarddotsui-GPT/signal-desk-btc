import pg from "pg";
import {
  WATERX_RESEARCH_POLICY,
  type ResearchChoice,
  type ResearchInterval,
} from "../../shared/waterx-research";
import {
  predictWaterxResearchShadow,
  RESEARCH_SHADOW_FEATURE_NAMES,
  type ResearchShadowArtifact,
  type ResearchShadowFeatures,
} from "./research-training-model";

export type ResearchShadowQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};
export type Queryable = ResearchShadowQueryable;

export type ResearchForwardCalibrationBucket = Readonly<{
  lower: number;
  upper: number;
  n: number;
  predictedUpMean: number;
  observedUpRate: number;
}>;

export type ResearchForwardMetric = Readonly<{
  n: number;
  brier: number | null;
  logLoss: number | null;
  calibration: ResearchForwardCalibrationBucket[];
}>;

/** Recorded predictions remain a shadow evaluation; this DTO cannot represent
 * an entry gate, live estimate, or promotion state. */
export type ResearchForwardEvaluation = Readonly<{
  intervalMinutes: ResearchInterval;
  asOf: string;
  schemaStatus: "available" | "unavailable";
  reason: string | null;
  recordedN: number;
  scoredN: number;
  unscoredN: number;
  disputedExcludedN: number;
  candidate: ResearchForwardMetric;
  marketBaseline: ResearchForwardMetric;
  status: "empty" | "recorded" | "scored" | "unavailable";
  shadowOnly: true;
}>;

type Evidence = Record<string, unknown>;
type DailyArtifactRow = Record<string, unknown>;
type StoredChoice = {
  intervalMinutes: ResearchInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
  checkpointAtMs: number;
  decisionAtMs: number;
  state: string;
  side: string | null;
  probabilityUp: number | null;
  probabilityDown: number | null;
  choiceSource: string | null;
  policyVersion: string;
  evidence: Evidence;
};
type PointInTime = {
  features: ResearchShadowFeatures;
  baselineProbabilityUp: number;
  featureProof: Record<string, unknown>;
};

const MAX_STATEMENT_MS = 10_000;
const POOL = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
  query_timeout: MAX_STATEMENT_MS,
  statement_timeout: MAX_STATEMENT_MS,
}) as unknown as ResearchShadowQueryable;
const METRIC_EMPTY: ResearchForwardMetric = {
  n: 0, brier: null, logLoss: null, calibration: [],
};

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function finite(value: unknown): number | null {
  const converted = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(converted) ? converted : null;
}

function object(value: unknown): Evidence | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Evidence : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Evidence)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function safeIso(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function choiceFromRow(row: Record<string, unknown>): StoredChoice | null {
  const intervalMinutes = finite(row.interval_minutes);
  const startMs = finite(row.start_ms);
  const expiryMs = finite(row.expiry_ms);
  const checkpointAtMs = finite(row.checkpoint_at_ms);
  const decisionAtMs = finite(row.decision_at_ms);
  const probabilityUp = row.probability_up === null ? null : finite(row.probability_up);
  const probabilityDown = row.probability_down === null ? null : finite(row.probability_down);
  const evidence = object(row.evidence);
  if ((intervalMinutes !== 5 && intervalMinutes !== 15) ||
      ![startMs, expiryMs, checkpointAtMs, decisionAtMs].every(value =>
        value !== null && Number.isFinite(value)) || !evidence)
    return null;
  return {
    intervalMinutes,
    roundId: typeof row.round_id === "string" ? row.round_id : "",
    startMs: startMs!,
    expiryMs: expiryMs!,
    checkpointAtMs: checkpointAtMs!,
    decisionAtMs: decisionAtMs!,
    state: String(row.state),
    side: typeof row.side === "string" ? row.side : null,
    probabilityUp,
    probabilityDown,
    choiceSource: typeof row.choice_source === "string" ? row.choice_source : null,
    policyVersion: String(row.policy_version ?? ""),
    evidence,
  };
}

async function choiceWithPersistedSupplement(
  db: ResearchShadowQueryable,
  choice: ResearchChoice,
  stored: StoredChoice,
): Promise<StoredChoice> {
  const suppliedEvidence = object(choice.evidence);
  const storedReference = object(stored.evidence.reference);
  const storedMarket = object(stored.evidence.market);
  const suppliedReference = object(suppliedEvidence?.reference);
  const suppliedMarket = object(suppliedEvidence?.market);
  if (!suppliedEvidence || canonical(storedReference) !== canonical(suppliedReference) ||
      canonical(storedMarket) !== canonical(suppliedMarket))
    throw new ShadowCaptureError(
      "SUPPLEMENT_RAW_EVIDENCE_MISMATCH",
      "Supplemented shadow input changed the original frozen reference or market evidence.",
    );
  if (canonical(stored.evidence.comparison) === canonical(suppliedEvidence.comparison))
    return stored;
  const supplementResult = await db.query(
    `SELECT feature_snapshot
       FROM waterx_research_feature_supplements
      WHERE interval_minutes=$1 AND round_id=$2 AND start_ms=$3
        AND expiry_ms=$4 AND decision_at_ms=$5`,
    [choice.intervalMinutes, choice.roundId, choice.startMs, choice.expiryMs, choice.decisionAtMs],
  );
  const snapshot = object(supplementResult.rows[0]?.feature_snapshot);
  const comparison = object(snapshot?.comparison);
  if (!comparison || canonical(comparison) !== canonical(suppliedEvidence.comparison) ||
      comparison.source !== "Coinbase" || comparison.coverage !== "complete")
    throw new ShadowCaptureError(
      "SUPPLEMENT_NOT_PERSISTED",
      "Enriched shadow features must exactly match a persisted complete decision-time supplement.",
    );
  return {
    ...stored,
    evidence: { ...stored.evidence, comparison },
  };
}

function pointInTimeFromChoice(choice: StoredChoice, choiceSettlement: ResearchChoice["settlement"]): PointInTime {
  const expectedCheckpointAtMs = choice.expiryMs -
    WATERX_RESEARCH_POLICY.checkpointSecondsBeforeClose[choice.intervalMinutes] * 1000;
  if (choice.state !== "FROZEN" || choice.choiceSource !== "market_baseline" ||
      choice.side !== "UP" && choice.side !== "DOWN" ||
      choice.policyVersion !== WATERX_RESEARCH_POLICY.version ||
      !choice.roundId.trim() ||
      choice.expiryMs - choice.startMs !== choice.intervalMinutes * 60_000 ||
      choice.checkpointAtMs !== expectedCheckpointAtMs ||
      choice.startMs >= choice.checkpointAtMs ||
      choice.checkpointAtMs >= choice.expiryMs ||
      choice.decisionAtMs < choice.checkpointAtMs ||
      choice.decisionAtMs > choice.checkpointAtMs + WATERX_RESEARCH_POLICY.checkpointGraceMs ||
      choice.decisionAtMs >= choice.expiryMs ||
      choice.probabilityUp === null || choice.probabilityDown === null ||
      choice.probabilityUp < 0 || choice.probabilityUp > 1 ||
      choice.probabilityDown < 0 || choice.probabilityDown > 1 ||
      Math.abs(choice.probabilityUp + choice.probabilityDown - 1) > 1e-6)
    throw new ShadowCaptureError("CHOICE_NOT_BASELINE", "Stored choice is not a valid immutable market-baseline prediction.");

  const reference = object(choice.evidence.reference);
  const market = object(choice.evidence.market);
  const comparison = object(choice.evidence.comparison);
  const refQuality = reference?.quality;
  const referencePrice = finite(reference?.price);
  const referenceObservedAtMs = finite(reference?.appObservedAtMs);
  const marketProbabilityUp = finite(market?.probabilityUp);
  const marketProbabilityDown = finite(market?.probabilityDown);
  const marketObservedAtMs = finite(market?.appObservedAtMs);
  const comparisonPrice = finite(comparison?.price);
  const sourceAtMs = finite(comparison?.sourceAtMs);
  const receivedAtMs = finite(comparison?.receivedAtMs);
  const return1m = finite(comparison?.return1m);
  const return3m = finite(comparison?.return3m);
  const realizedVolatility = finite(comparison?.realizedVolatility);
  const tickCount = finite(comparison?.tickCount);
  if (!reference || reference.source !== "WaterX" ||
      refQuality !== "provisional" && refQuality !== "confirmed" ||
      referencePrice === null || referencePrice <= 0 ||
      referenceObservedAtMs === null || referenceObservedAtMs < choice.startMs ||
      referenceObservedAtMs > choice.decisionAtMs ||
      !market || market.timestampKind !== "app-observed" ||
      marketProbabilityUp === null || marketProbabilityDown === null ||
      marketProbabilityUp < 0 || marketProbabilityUp > 1 ||
      marketProbabilityDown < 0 || marketProbabilityDown > 1 ||
      Math.abs(marketProbabilityUp + marketProbabilityDown - 1) > 1e-6 ||
      choice.probabilityUp !== marketProbabilityUp ||
      choice.probabilityDown !== marketProbabilityDown ||
      marketObservedAtMs === null || marketObservedAtMs < choice.startMs ||
      marketObservedAtMs > choice.decisionAtMs ||
      choice.decisionAtMs - marketObservedAtMs > WATERX_RESEARCH_POLICY.maxOddsAgeMs ||
      !comparison || comparison.source !== "Coinbase" ||
      comparison.coverage !== "complete" ||
      comparisonPrice === null || comparisonPrice <= 0 ||
      sourceAtMs === null || sourceAtMs > choice.decisionAtMs ||
      receivedAtMs === null || receivedAtMs > choice.decisionAtMs ||
      sourceAtMs - receivedAtMs > WATERX_RESEARCH_POLICY.maxComparisonGapMs ||
      choice.decisionAtMs - sourceAtMs > WATERX_RESEARCH_POLICY.maxComparisonGapMs ||
      return1m === null || Math.abs(return1m) > 0.1 ||
      return3m === null || Math.abs(return3m) > 0.1 ||
      realizedVolatility === null || realizedVolatility < 0 ||
      realizedVolatility > 0.05 ||
      tickCount === null || tickCount < 3 ||
      choiceSettlement.state !== "pending" ||
      choiceSettlement.outcome !== null || choiceSettlement.labelAvailableAt !== null)
    throw new ShadowCaptureError(
      "INVALID_POINT_IN_TIME_FEATURES",
      "Frozen choice lacks complete, timely Coinbase and observed-reference features or already contains a label.",
    );

  // comparisonFeatures stores population log-return standard deviation as a
  // ratio. The training feature schema is basis points; convert once here.
  const realizedVolatilityBps = realizedVolatility * 10_000;
  const features: ResearchShadowFeatures = {
    marketProbabilityUp,
    referenceDistanceBps: (comparisonPrice / referencePrice - 1) * 10_000,
    timeRemainingFraction: (choice.expiryMs - choice.decisionAtMs) /
      (choice.expiryMs - choice.startMs),
    return1m,
    return3m,
    realizedVolatilityBps,
    sourceAgeMs: choice.decisionAtMs - sourceAtMs,
  };
  if (!Number.isFinite(features.referenceDistanceBps) ||
      Math.abs(features.referenceDistanceBps) > 100_000 ||
      !Number.isFinite(realizedVolatilityBps) || realizedVolatilityBps > 500)
    throw new ShadowCaptureError(
      "INVALID_POINT_IN_TIME_FEATURES",
      "Frozen research features exceed the bounded shadow model feature schema.",
    );
  return {
    features,
    baselineProbabilityUp: marketProbabilityUp,
    featureProof: {
      policyVersion: choice.policyVersion,
      reference: {
        price: referencePrice, quality: refQuality, source: "WaterX",
        appObservedAtMs: referenceObservedAtMs,
      },
      market: {
        probabilityUp: marketProbabilityUp,
        probabilityDown: marketProbabilityDown,
        appObservedAtMs: marketObservedAtMs,
        timestampKind: market.timestampKind,
      },
      comparison: {
        source: "Coinbase",
        price: comparisonPrice,
        sourceAtMs,
        receivedAtMs,
        return1m,
        return3m,
        realizedVolatility,
        realizedVolatilityBps,
        volatilityConversion: "source log-return standard deviation * 10000 exactly once",
        tickCount,
        coverage: "complete",
      },
      featureNames: [...RESEARCH_SHADOW_FEATURE_NAMES],
    },
  };
}

class ShadowCaptureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function safeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown shadow inference error.";
  return message.replace(/'(?:[^']|'')*'/g, "'[redacted]'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"[redacted]"')
    .slice(0, 1000);
}

async function captureArtifactPrediction(
  db: ResearchShadowQueryable,
  stored: StoredChoice,
  point: PointInTime,
  resolved: { artifact: ResearchShadowArtifact; finishedAtMs: number },
): Promise<void> {
  const probabilityUp = predictWaterxResearchShadow(resolved.artifact, point.features);
  const observedAtMs = Date.now();
  const checkpointDeadlineMs = stored.checkpointAtMs + WATERX_RESEARCH_POLICY.checkpointGraceMs;
  if (observedAtMs < stored.decisionAtMs ||
      observedAtMs >= stored.expiryMs ||
      observedAtMs > checkpointDeadlineMs)
    throw new ShadowCaptureError(
      "SHADOW_CAPTURE_TOO_LATE",
      "Forward shadow inference finished outside the immutable-choice checkpoint window.",
    );
  const featureProof = {
    ...point.featureProof,
    choice: {
      intervalMinutes: stored.intervalMinutes,
      roundId: stored.roundId,
      startMs: stored.startMs,
      expiryMs: stored.expiryMs,
      checkpointAtMs: stored.checkpointAtMs,
      decisionAtMs: stored.decisionAtMs,
      side: stored.side,
      choiceSource: stored.choiceSource,
      probabilityUp: stored.probabilityUp,
    },
    artifact: {
      version: resolved.artifact.version,
      calibrationVersion: `${resolved.artifact.version}:platt`,
      datasetFingerprint: resolved.artifact.datasetFingerprint,
      finishedAtMs: resolved.finishedAtMs,
      evidenceAvailableThroughMs: resolved.artifact.evidenceAvailableThroughMs,
      modelStatus: "shadow-only",
      promoted: false,
    },
  };
  const inserted = await db.query(
    `INSERT INTO waterx_research_shadow_predictions
      (interval_minutes,round_id,artifact_version,probability_up,
       baseline_probability_up,observed_at_ms,decision_at_ms,model_version,
       calibration_version,dataset_fingerprint,features,evidence)
     SELECT $1::smallint,$2::text,$3::text,$4::double precision,
            $5::double precision,$6::bigint,$7::bigint,$3::text,
            $8::text,$9::text,$10::jsonb,$11::jsonb
      WHERE $6::bigint >= $7::bigint
        AND $6::bigint < $12::bigint AND $6::bigint <= $13::bigint
        AND clock_timestamp() >= to_timestamp($7::double precision / 1000.0)
        AND clock_timestamp() < to_timestamp($12::double precision / 1000.0)
        AND clock_timestamp() <= to_timestamp($13::double precision / 1000.0)
        AND EXISTS (
          SELECT 1 FROM waterx_research_choices official
           WHERE official.interval_minutes=$1::smallint AND official.round_id=$2::text
             AND official.state='FROZEN'
             AND official.choice_source='market_baseline'
             AND official.decision_at_ms=$7::bigint
             AND official.probability_up=$5::numeric
             AND (official.evidence->'market'->>'probabilityUp')::numeric=$14::numeric
        )
     ON CONFLICT (interval_minutes,round_id,artifact_version) DO NOTHING
     RETURNING artifact_version`,
    [stored.intervalMinutes, stored.roundId, resolved.artifact.version,
      probabilityUp, point.baselineProbabilityUp, observedAtMs, stored.decisionAtMs,
      `${resolved.artifact.version}:platt`, resolved.artifact.datasetFingerprint,
      JSON.stringify(point.features), JSON.stringify(featureProof), stored.expiryMs,
      stored.checkpointAtMs + WATERX_RESEARCH_POLICY.checkpointGraceMs,
      String(point.baselineProbabilityUp)],
  );
  if (!inserted.rows.length) {
    const existing = await db.query(
      `SELECT artifact_version
         FROM waterx_research_shadow_predictions
        WHERE interval_minutes=$1 AND round_id=$2 AND artifact_version=$3`,
      [stored.intervalMinutes, stored.roundId, resolved.artifact.version],
    );
    if (!existing.rows.length)
      throw new ShadowCaptureError(
        "SHADOW_INSERT_REJECTED",
        "The database refused the timely immutable shadow prediction or its frozen baseline proof.",
      );
  }
}

function parseArtifact(row: DailyArtifactRow, choiceDecisionAtMs: number): {
  artifact: ResearchShadowArtifact;
  finishedAtMs: number;
} {
  const artifact = object(row.artifact);
  const report = object(row.report);
  const nestedArtifact = object(report?.shadowArtifact);
  const eligibility = object(report?.eligibility);
  const test = object(report?.test);
  const finishedAtMs = safeIso(row.finished_at);
  const datasetFingerprint = typeof row.dataset_fingerprint === "string"
    ? row.dataset_fingerprint : "";
  if (row.status !== "evaluated" || !artifact || !report || !nestedArtifact ||
      report.status !== "candidate-evaluated" ||
      report.protocol !== "waterx-frozen-research-choices-60-20-20-v2" ||
      eligibility?.eligible !== true || finite(test?.count) === null ||
      finite(test?.count)! < 20 || !report.calibrationFit ||
      artifact.status !== "shadow-only" || artifact.promoted !== false ||
      canonical(nestedArtifact) !== canonical(artifact) ||
      typeof artifact.version !== "string" ||
      !artifact.version.startsWith("waterx-research-shadow-v2:") ||
      artifact.datasetFingerprint !== datasetFingerprint ||
      report.datasetFingerprint !== datasetFingerprint ||
      nestedArtifact.version !== artifact.version ||
      nestedArtifact.datasetFingerprint !== datasetFingerprint ||
      nestedArtifact.evidenceAvailableThroughMs !== artifact.evidenceAvailableThroughMs ||
      finishedAtMs === null || finishedAtMs >= choiceDecisionAtMs)
    throw new ShadowCaptureError(
      "SHADOW_ARTIFACT_UNAVAILABLE",
      "No completed, compatible, shadow-only research artifact predates this immutable choice.",
    );

  const evidenceAvailableThroughMs = finite(artifact.evidenceAvailableThroughMs);
  const featureNames = Array.isArray(artifact.featureNames) ? artifact.featureNames : [];
  const means = Array.isArray(artifact.means) ? artifact.means.map(finite) : [];
  const scales = Array.isArray(artifact.scales) ? artifact.scales.map(finite) : [];
  const coefficients = Array.isArray(artifact.coefficients)
    ? artifact.coefficients.map(finite) : [];
  const calibration = object(artifact.calibration);
  const slope = finite(calibration?.slope);
  const calibrationIntercept = finite(calibration?.intercept);
  const intercept = finite(artifact.intercept);
  const datasetVersion = typeof artifact.version === "string" ? artifact.version : "";
  if (evidenceAvailableThroughMs === null ||
      evidenceAvailableThroughMs > finishedAtMs ||
      evidenceAvailableThroughMs > choiceDecisionAtMs ||
      datasetVersion !== `waterx-research-shadow-v2:${row.interval_minutes}:` +
        datasetFingerprint.slice(0, 16) ||
      featureNames.length !== RESEARCH_SHADOW_FEATURE_NAMES.length ||
      featureNames.some((name, index) => name !== RESEARCH_SHADOW_FEATURE_NAMES[index]) ||
      means.length !== RESEARCH_SHADOW_FEATURE_NAMES.length ||
      means.some(value => value === null) ||
      scales.length !== RESEARCH_SHADOW_FEATURE_NAMES.length ||
      scales.some(value => value === null || value <= 0) ||
      coefficients.length !== RESEARCH_SHADOW_FEATURE_NAMES.length ||
      coefficients.some(value => value === null) ||
      intercept === null || slope === null || calibrationIntercept === null)
    throw new ShadowCaptureError(
      "SHADOW_ARTIFACT_INVALID",
      "Research artifact is malformed or includes features/labels observed after it finished.",
    );

  return {
    artifact: {
      status: "shadow-only",
      promoted: false,
      version: datasetVersion,
      datasetFingerprint,
      featureNames: featureNames as string[],
      means: means as number[],
      scales: scales as number[],
      coefficients: coefficients as number[],
      intercept,
      calibration: { slope, intercept: calibrationIntercept },
      evidenceAvailableThroughMs,
    },
    finishedAtMs,
  };
}

function captureIdentity(choice: ResearchChoice): {
  intervalMinutes: ResearchInterval;
  roundId: string;
  startMs: number;
  expiryMs: number;
} | null {
  if (!choice || (choice.intervalMinutes !== 5 && choice.intervalMinutes !== 15) ||
      typeof choice.roundId !== "string" || !choice.roundId.trim() ||
      !Number.isSafeInteger(choice.startMs) || !Number.isSafeInteger(choice.expiryMs))
    return null;
  return {
    intervalMinutes: choice.intervalMinutes,
    roundId: choice.roundId,
    startMs: choice.startMs,
    expiryMs: choice.expiryMs,
  };
}

async function recordCaptureError(
  db: ResearchShadowQueryable,
  identity: ReturnType<typeof captureIdentity>,
  error: unknown,
): Promise<void> {
  if (!identity) {
    console.warn("[waterx-research] shadow prediction failed without a valid round identity:",
      safeErrorReason(error));
    return;
  }
  const code = error instanceof ShadowCaptureError ? error.code : "SHADOW_CAPTURE_FAILED";
  const databaseCode = !(error instanceof ShadowCaptureError) &&
      typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code) : null;
  const reason = safeErrorReason(error);
  console.warn("[waterx-research] shadow prediction failed:", {
    code,
    databaseCode,
    reason,
  });
  try {
    await db.query(
      `INSERT INTO waterx_research_capture_events
        (interval_minutes,round_id,start_ms,expiry_ms,stage,code,reason,details)
       VALUES ($1,$2,$3,$4,'shadow_forward_prediction',$5,$6,$7::jsonb)
       ON CONFLICT (interval_minutes,start_ms,stage,code) DO NOTHING`,
      [identity.intervalMinutes, identity.roundId, identity.startMs, identity.expiryMs,
        code, reason, JSON.stringify({
          errorName: error instanceof Error ? error.name : "UnknownError",
          databaseCode,
        })],
    );
  } catch (eventError) {
    // This sidecar is fail-soft even if its migration or database is absent:
    // the already-committed official market-baseline choice is never rolled back.
    console.warn("[waterx-research] shadow inference error event could not be persisted:",
      safeErrorReason(eventError));
  }
}

/** Called only after the official immutable choice has committed. This function
 * can insert only a separate shadow row and always fails soft for the choice. */
export async function captureResearchShadowPrediction(
  choice: ResearchChoice,
  db: ResearchShadowQueryable = POOL,
): Promise<void> {
  const identity = captureIdentity(choice);
  try {
    if (!identity || !process.env.DATABASE_URL && db === POOL)
      throw new ShadowCaptureError(
        "RESEARCH_SHADOW_SCHEMA_UNAVAILABLE",
        "A persisted research database and a valid frozen choice are required for shadow inference.",
      );
    const storedResult = await db.query(
      `SELECT interval_minutes,round_id,start_ms,expiry_ms,checkpoint_at_ms,
              decision_at_ms,state,side,probability_up,probability_down,
              choice_source,policy_version,evidence
         FROM waterx_research_choices
        WHERE interval_minutes=$1 AND round_id=$2`,
      [identity.intervalMinutes, identity.roundId],
    );
    let stored = choiceFromRow(storedResult.rows[0] ?? {});
    if (!stored || stored.startMs !== choice.startMs ||
        stored.expiryMs !== choice.expiryMs ||
        stored.checkpointAtMs !== choice.checkpointAtMs ||
        stored.decisionAtMs !== choice.decisionAtMs ||
        stored.state !== choice.state ||
        stored.side !== choice.side ||
        stored.choiceSource !== choice.choiceSource ||
        stored.policyVersion !== choice.policyVersion ||
        stored.probabilityUp !== choice.probabilityUp ||
        stored.probabilityDown !== choice.probabilityDown)
      throw new ShadowCaptureError(
        "IMMUTABLE_CHOICE_NOT_FOUND",
        "Shadow prediction requires the exact committed immutable choice row.",
      );

    stored = await choiceWithPersistedSupplement(db, choice, stored);
    const point = pointInTimeFromChoice(stored, choice.settlement);
    const checkpointDeadlineMs = stored.checkpointAtMs + WATERX_RESEARCH_POLICY.checkpointGraceMs;
    const insertTimeMs = Date.now();
    if (stored.decisionAtMs > insertTimeMs ||
        insertTimeMs >= stored.expiryMs ||
        insertTimeMs > checkpointDeadlineMs)
      throw new ShadowCaptureError(
        "SHADOW_CAPTURE_TOO_LATE",
        "Forward shadow prediction is past its actual round expiry or checkpoint-grace cutoff.",
      );

    const artifactResult = await db.query(
      `SELECT interval_minutes,status,finished_at,dataset_fingerprint,report,artifact
         FROM waterx_research_daily_runs
        WHERE interval_minutes=$1 AND status='evaluated' AND artifact IS NOT NULL
          AND finished_at < to_timestamp($2::double precision / 1000.0)
        ORDER BY finished_at DESC,scheduled_day DESC
        LIMIT 2`,
      [identity.intervalMinutes, stored.decisionAtMs],
    );
    if (!artifactResult.rows.length)
      throw new ShadowCaptureError(
        "SHADOW_ARTIFACT_UNAVAILABLE",
        "No completed compatible rich shadow artifacts predate this immutable choice.",
      );
    let captured = 0;
    for (const artifactRow of artifactResult.rows.slice(0, 2)) {
      try {
        const resolved = parseArtifact(artifactRow, stored.decisionAtMs);
        await captureArtifactPrediction(db, stored, point, resolved);
        captured++;
      } catch (error) {
        // One malformed historical artifact must not suppress capture with a
        // different valid artifact that was also published before this choice.
        await recordCaptureError(db, identity, error);
      }
    }
    if (!captured)
      throw new ShadowCaptureError(
        "SHADOW_ARTIFACT_UNAVAILABLE",
        "Neither of the two newest pre-choice rich artifacts passed shadow validation.",
      );
  } catch (error) {
    await recordCaptureError(db, identity, error);
  }
}

function unavailableEvaluation(
  intervalMinutes: ResearchInterval,
  reason: string,
): ResearchForwardEvaluation {
  return {
    intervalMinutes,
    asOf: new Date().toISOString(),
    schemaStatus: "unavailable",
    reason,
    recordedN: 0,
    scoredN: 0,
    unscoredN: 0,
    disputedExcludedN: 0,
    candidate: METRIC_EMPTY,
    marketBaseline: METRIC_EMPTY,
    status: "unavailable",
    shadowOnly: true,
  };
}

function parseCalibration(value: unknown): ResearchForwardCalibrationBucket[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(item => {
    const row = object(item);
    if (!row) return [];
    const lower = finite(row.lower);
    const upper = finite(row.upper);
    const n = finite(row.n);
    const predictedUpMean = finite(row.predictedUpMean);
    const observedUpRate = finite(row.observedUpRate);
    return lower === null || upper === null || n === null ||
        predictedUpMean === null || observedUpRate === null
      ? [] : [{ lower, upper, n, predictedUpMean, observedUpRate }];
  });
}

function parseMetric(row: Record<string, unknown>, prefix: "candidate" | "baseline", n: number): ResearchForwardMetric {
  const metricCount = finite(row[`${prefix}_n`]) ?? n;
  return {
    n: metricCount,
    brier: finite(row[`${prefix}_brier`]),
    logLoss: finite(row[`${prefix}_log_loss`]),
    calibration: parseCalibration(row[`${prefix}_calibration`]),
  };
}

/** Aggregates predictions against their same-round official market baseline.
 * Only exact verified, non-disputed WaterX labels are admitted to scored N. */
export async function getResearchForwardEvaluation(
  intervalMinutes: ResearchInterval,
  db: ResearchShadowQueryable = POOL,
): Promise<ResearchForwardEvaluation> {
  if (intervalMinutes !== 5 && intervalMinutes !== 15)
    return unavailableEvaluation(5, "Research forward-evaluation interval must be 5 or 15 minutes.");
  if (!process.env.DATABASE_URL && db === POOL)
    return unavailableEvaluation(intervalMinutes, "DATABASE_URL is not configured.");
  try {
    const result = await db.query(
      `WITH recorded AS MATERIALIZED (
         SELECT p.interval_minutes,p.round_id,p.probability_up,p.baseline_probability_up,
                p.decision_at_ms,c.start_ms AS choice_start_ms,c.expiry_ms AS choice_expiry_ms,
                c.choice_source,c.state,c.evidence AS choice_evidence,
                l.label_status,l.settlement_disputed,l.settlement_quarantine,
                l.settlement_anchor_price,l.settle_price,l.outcome,l.settled_at,
                l.start_ms AS label_start_ms,l.expiry_ms AS label_expiry_ms,
                l.settlement_observed_at,l.first_verified_at
           FROM waterx_research_shadow_predictions p
           LEFT JOIN waterx_research_choices c
             ON c.interval_minutes=p.interval_minutes AND c.round_id=p.round_id
            LEFT JOIN waterx_learning_rounds l
              ON l.interval_minutes=p.interval_minutes AND l.round_id=p.round_id
             AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
          WHERE p.interval_minutes=$1
       ), scored AS (
         SELECT probability_up::double precision AS candidate_probability,
                baseline_probability_up::double precision AS baseline_probability,
                CASE WHEN outcome IN ('UP','Up') THEN 1.0 ELSE 0.0 END AS y
           FROM recorded
          WHERE state='FROZEN' AND choice_source='market_baseline'
            AND label_status='verified' AND settlement_disputed IS FALSE
            AND settlement_anchor_price>0 AND settle_price>0
            AND outcome IN ('UP','Up','DOWN','Down')
             AND settled_at>choice_expiry_ms AND settlement_observed_at IS NOT NULL
            AND settlement_observed_at >=
                to_timestamp(settled_at::double precision / 1000.0)
            AND settlement_observed_at <= clock_timestamp()
             AND first_verified_at IS NOT NULL
             AND first_verified_at >= to_timestamp(settled_at::double precision / 1000.0)
             AND first_verified_at <= clock_timestamp()
             AND settled_at <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint
            AND (settlement_quarantine IS NULL OR settlement_quarantine='[]'::jsonb)
            AND ((outcome IN ('UP','Up') AND settle_price>=settlement_anchor_price)
              OR (outcome IN ('DOWN','Down') AND settle_price<settlement_anchor_price))
            AND choice_evidence->'market'->>'probabilityUp' IS NOT NULL
            AND baseline_probability_up::numeric =
                (choice_evidence->'market'->>'probabilityUp')::numeric
       ), candidate_bins AS (
         SELECT LEAST(9,FLOOR(candidate_probability*10)::integer) AS band,
                COUNT(*)::integer AS n,AVG(candidate_probability) AS predicted,
                AVG(y) AS observed
           FROM scored GROUP BY 1
       ), baseline_bins AS (
         SELECT LEAST(9,FLOOR(baseline_probability*10)::integer) AS band,
                COUNT(*)::integer AS n,AVG(baseline_probability) AS predicted,
                AVG(y) AS observed
           FROM scored GROUP BY 1
       )
       SELECT (SELECT COUNT(*)::integer FROM recorded) AS recorded_n,
              (SELECT COUNT(*)::integer FROM scored) AS scored_n,
              (SELECT COUNT(*)::integer FROM recorded
                WHERE settlement_disputed IS TRUE) AS disputed_excluded_n,
              AVG(POWER(candidate_probability-y,2)) AS candidate_brier,
              AVG(CASE WHEN y=1 THEN -LN(GREATEST(1e-15,candidate_probability))
                ELSE -LN(GREATEST(1e-15,1-candidate_probability)) END) AS candidate_log_loss,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'lower',band/10.0,'upper',(band+1)/10.0,'n',n,
                  'predictedUpMean',predicted,'observedUpRate',observed)
                  ORDER BY band),'[]'::jsonb)::text FROM candidate_bins) AS candidate_calibration,
              AVG(POWER(baseline_probability-y,2)) AS baseline_brier,
              AVG(CASE WHEN y=1 THEN -LN(GREATEST(1e-15,baseline_probability))
                ELSE -LN(GREATEST(1e-15,1-baseline_probability)) END) AS baseline_log_loss,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'lower',band/10.0,'upper',(band+1)/10.0,'n',n,
                  'predictedUpMean',predicted,'observedUpRate',observed)
                  ORDER BY band),'[]'::jsonb)::text FROM baseline_bins) AS baseline_calibration
         FROM scored`,
      [intervalMinutes],
    );
    const row = result.rows[0] ?? {};
    const recordedN = finite(row.recorded_n) ?? 0;
    const scoredN = finite(row.scored_n) ?? 0;
    return {
      intervalMinutes,
      asOf: new Date().toISOString(),
      schemaStatus: "available",
      reason: scoredN ? null : recordedN
        ? "Forward predictions are recorded; scoring waits for exact verified, non-disputed WaterX settlements."
        : "No forward shadow predictions are recorded yet.",
      recordedN,
      scoredN,
      unscoredN: Math.max(0, recordedN - scoredN),
      disputedExcludedN: finite(row.disputed_excluded_n) ?? 0,
      candidate: parseMetric({
        candidate_n: scoredN,
        candidate_brier: row.candidate_brier,
        candidate_log_loss: row.candidate_log_loss,
        candidate_calibration: row.candidate_calibration,
      }, "candidate", scoredN),
      marketBaseline: parseMetric({
        baseline_n: scoredN,
        baseline_brier: row.baseline_brier,
        baseline_log_loss: row.baseline_log_loss,
        baseline_calibration: row.baseline_calibration,
      }, "baseline", scoredN),
      status: scoredN ? "scored" : recordedN ? "recorded" : "empty",
      shadowOnly: true,
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return unavailableEvaluation(intervalMinutes,
      code === "42P01" || code === "3F000" || code === "42703"
        ? "Reviewed research-shadow schema is unavailable."
        : `Forward shadow evaluation failed closed: ${error instanceof Error
          ? error.message : "Unknown database error."}`);
  }
}
