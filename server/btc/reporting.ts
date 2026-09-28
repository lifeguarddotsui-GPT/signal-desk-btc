import pg from "pg";
import { parseBtcArtifact } from "./artifact";

const REPORT_QUERY_LIMIT = 100_000;
const EXPORT_DEFAULT_LIMIT = 50;
const EXPORT_MAX_LIMIT = 100;
const LOG_FLOOR = 1e-9;
const HALF_HOUR_MS = 30 * 60_000;

const reportPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  application_name: "btc-accuracy-reporting-read-only",
});

export type AccuracyPeriod = "daily" | "sevenDay" | "lifetime";
export type ExportCollection = "predictions" | "outcomes" | "scores";
export type ExportPageOptions = { cursor?: string | null; limit?: number };
export type AccuracyDatasetCoverage = {
  lifetimeComplete: boolean;
  dailyComplete: boolean;
  sevenDayComplete: boolean;
};

type Outcome = "UP" | "DOWN" | "UNKNOWN" | null;
type Action = "UP" | "DOWN" | "HOLD" | null;

export type AccuracyInputRow = {
  roundId: string;
  expiryMs: number;
  outcome: Outcome;
  quality: string;
  settlementPresent: boolean;
  settlementVerifiedAtMs: number | null;
  predictionId: string | null;
  predictionAtMs: number | null;
  capturedAtMs: number | null;
  remainingSeconds: number | null;
  marketUp: number | null;
  forecastUp: number | null;
  modelVersion: string | null;
  action: Action;
  scoreAtMs: number | null;
  scoreKind: string | null;
  snapshotInWindow: boolean;
  hasPreExpirySnapshot: boolean;
  modelStatus: string | null;
  modelCreatedAtMs: number | null;
  modelTrainedThroughMs: number | null;
  modelCalibratedAtMs: number | null;
  hasFrozenArtifact: boolean;
  artifactMatchesVersion: boolean;
};

type SeriesMetrics = {
  evaluatedRounds: number;
  brier: number | null;
  logLoss: number | null;
  upCalls: number;
  downCalls: number;
  directionalCalls: number;
  directionalHits: number;
  hitRate: number | null;
  abstentions: number;
  coverage: number | null;
  calibrationByProbability: Array<{
    lower: number;
    upper: number;
    count: number;
    meanPredictedUp: number | null;
    observedUpRate: number | null;
  }>;
  byRemainingTime: Array<{
    bucket: string;
    count: number;
    meanPredictedUp: number | null;
    brier: number | null;
    logLoss: number | null;
    observedUpRate: number | null;
    calibrationError: number | null;
  }>;
  brierUncertainty: {
    lower: number | null;
    upper: number | null;
    method: string;
    effectiveSampleSize: number;
    blockCount: number;
    blockDurationMinutes: number;
  };
};

type EligibleRow = AccuracyInputRow & {
  predictionId: string;
  predictionAtMs: number;
  remainingSeconds: number;
  marketUp: number;
  outcome: "UP" | "DOWN";
  scoreAtMs: number;
};

function finiteProbability(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
}

function safeMetrics(rows: EligibleRow[], probability: (row: EligibleRow) => number | null): SeriesMetrics {
  const selected = rows.filter(row => finiteProbability(probability(row)));
  const actual = selected.map(row => probability(row)!);
  const outcomes = selected.map(row => row.outcome === "UP" ? 1 : 0);
  const briers = actual.map((p, i) => (p - outcomes[i]) ** 2);
  const logLosses = actual.map((p, i) =>
    -Math.log(Math.max(LOG_FLOOR, outcomes[i] ? p : 1 - p)));

  // Equal-count bins adapt to the available sample. Suppress an observed
  // frequency when fewer than 20 independent round outcomes occupy a bin.
  const sorted = actual.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const binCount = Math.min(10, Math.max(1, Math.floor(sorted.length / 20)));
  const bins = Array.from({ length: binCount }, (_, index) => {
    const indices = sorted.slice(
      Math.floor(index * sorted.length / binCount),
      Math.floor((index + 1) * sorted.length / binCount),
    );
    return {
      lower: indices[0]?.p ?? 0, upper: indices.at(-1)?.p ?? 1,
      count: indices.length,
      meanPredictedUp: indices.length
        ? indices.reduce((sum, item) => sum + item.p, 0) / indices.length : null,
      observedUpRate: indices.length >= 20
        ? indices.reduce((sum, item) => sum + outcomes[item.i], 0) / indices.length : null,
    };
  });
  const remainingBuckets = [
    { label: "30–35s", minimum: 30, maximum: 35 },
    { label: "35–40s", minimum: 35, maximum: 40 },
    { label: "40–45s", minimum: 40, maximum: 45.000001 },
  ];
  const byRemainingTime = remainingBuckets.map(bucket => {
    const indices = selected.map((row, i) => ({ row, i }))
      .filter(({ row }) => row.remainingSeconds >= bucket.minimum &&
        row.remainingSeconds < bucket.maximum);
    const sum = (values: number[]) => indices.length
      ? indices.reduce((total, item) => total + values[item.i], 0) / indices.length : null;
    const meanPredictedUp = indices.length
      ? indices.reduce((total, item) => total + actual[item.i], 0) / indices.length : null;
    const observedUpRate = indices.length >= 20
      ? indices.reduce((total, item) => total + outcomes[item.i], 0) / indices.length : null;
    return {
      bucket: bucket.label,
      count: indices.length,
      meanPredictedUp,
      brier: sum(briers),
      logLoss: sum(logLosses),
      observedUpRate,
      calibrationError: meanPredictedUp === null || observedUpRate === null
        ? null : observedUpRate - meanPredictedUp,
    };
  });

  const meanBrier = briers.length ? briers.reduce((sum, value) => sum + value, 0) / briers.length : null;
  const blockDeviations = new Map<number, number>();
  selected.forEach((row, index) => {
    const block = Math.floor(row.expiryMs / HALF_HOUR_MS);
    blockDeviations.set(block, (blockDeviations.get(block) ?? 0) +
      briers[index] - meanBrier!);
  });
  const blocks = blockDeviations.size;
  const clusterVariance = blocks >= 8 && briers.length
    ? blocks / (blocks - 1) * Array.from(blockDeviations.values())
      .reduce((sum, value) => sum + value ** 2, 0) / briers.length ** 2
    : null;
  const blockSe = clusterVariance === null ? null : Math.sqrt(clusterVariance);
  const actions = selected.map(row => row.action);
  const directional = selected.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.action === "UP" || row.action === "DOWN");
  const directionalHits = directional.filter(({ row }) => row.action === row.outcome).length;
  const abstentions = actions.filter(action => action === "HOLD").length;
  return {
    evaluatedRounds: selected.length,
    brier: meanBrier,
    logLoss: logLosses.length ? logLosses.reduce((sum, value) => sum + value, 0) / logLosses.length : null,
    upCalls: actions.filter(action => action === "UP").length,
    downCalls: actions.filter(action => action === "DOWN").length,
    directionalCalls: directional.length,
    directionalHits,
    hitRate: directional.length ? directionalHits / directional.length : null,
    abstentions,
    coverage: selected.length ? directional.length / selected.length : null,
    calibrationByProbability: bins,
    byRemainingTime,
    brierUncertainty: {
      lower: blockSe === null ? null : Math.max(0, meanBrier! - 1.96 * blockSe),
      upper: blockSe === null ? null : Math.min(1, meanBrier! + 1.96 * blockSe),
      method: "Cluster-robust descriptive normal interval using 30-minute expiry-time block sums only with at least 8 non-empty blocks; not a promotion test. Bin outcome frequencies require 20 rounds.",
      effectiveSampleSize: blocks,
      blockCount: blocks,
      blockDurationMinutes: 30,
    },
  };
}

function activeForecastArtifact(
  row: AccuracyInputRow,
  asOfMs: number,
  requiredStatus: "SHADOW" | "CHAMPION",
): boolean {
  return row.modelVersion !== null &&
    row.forecastUp !== null && finiteProbability(row.forecastUp) &&
    row.hasFrozenArtifact &&
    row.artifactMatchesVersion &&
    row.modelStatus === requiredStatus &&
    (row.scoreKind === "SHADOW_FORECAST" || row.scoreKind === "CHAMPION_FORECAST") &&
    row.modelCreatedAtMs !== null && row.modelCreatedAtMs <= row.predictionAtMs! &&
    row.modelCalibratedAtMs !== null && row.modelCalibratedAtMs <= row.predictionAtMs! &&
    row.modelTrainedThroughMs !== null && row.modelTrainedThroughMs < row.predictionAtMs! &&
    row.predictionAtMs! < row.expiryMs && row.predictionAtMs! <= asOfMs;
}

function classifyExclusion(row: AccuracyInputRow): string | null {
  if (!row.predictionId) {
    if (row.snapshotInWindow) return "missing_prediction_record";
    if (row.hasPreExpirySnapshot) return "missed_prediction_window";
    return "no_pre_expiry_observation";
  }
  if (row.predictionAtMs === null || row.predictionAtMs >= row.expiryMs) return "prediction_not_pre_expiry";
  if (row.capturedAtMs === null || row.capturedAtMs >= row.expiryMs) return "prediction_persisted_after_expiry";
  if (row.remainingSeconds === null || !Number.isFinite(row.remainingSeconds) ||
      row.remainingSeconds < 30 || row.remainingSeconds > 45)
    return "invalid_primary_horizon";
  if (Math.abs(row.remainingSeconds - (row.expiryMs - row.predictionAtMs) / 1000) > 1)
    return "inconsistent_issue_timestamp";
  if (!row.settlementPresent) return "missing_settlement";
  if (row.quality !== "VERIFIED_SETTLEMENT" ||
      row.settlementVerifiedAtMs === null ||
      row.settlementVerifiedAtMs < row.expiryMs) return "settlement_not_independently_verified";
  if (row.outcome !== "UP" && row.outcome !== "DOWN") return "unsupported_or_unknown_outcome";
  if (!finiteProbability(row.marketUp)) return row.marketUp === null
    ? "missing_probability" : "invalid_probability";
  if (row.scoreAtMs === null) return "verified_prediction_not_scored";
  if (row.action !== "UP" && row.action !== "DOWN" && row.action !== "HOLD")
    return "invalid_action_schema";
  return null;
}

function toEligible(row: AccuracyInputRow): EligibleRow | null {
  if (classifyExclusion(row) || row.predictionAtMs === null ||
      row.remainingSeconds === null || row.scoreAtMs === null ||
      !finiteProbability(row.marketUp) ||
      (row.outcome !== "UP" && row.outcome !== "DOWN")) return null;
  return row as EligibleRow;
}

function scoreablePrediction(row: AccuracyInputRow): boolean {
  const exclusion = classifyExclusion(row);
  if (exclusion !== null && exclusion !== "verified_prediction_not_scored") return false;
  const isShadowVersion = row.modelVersion?.startsWith("btc-shadow-logistic-v1-") ?? false;
  return !isShadowVersion || finiteProbability(row.forecastUp);
}

function selectRoundPredictions(rows: AccuracyInputRow[]): AccuracyInputRow[] {
  const groups = new Map<string, AccuracyInputRow[]>();
  for (const row of rows) {
    const group = groups.get(row.roundId) ?? [];
    group.push(row);
    groups.set(row.roundId, group);
  }
  const byIssueTime = (a: AccuracyInputRow, b: AccuracyInputRow) =>
    (a.predictionAtMs ?? Number.POSITIVE_INFINITY) -
      (b.predictionAtMs ?? Number.POSITIVE_INFINITY) ||
    String(a.predictionId ?? "").localeCompare(String(b.predictionId ?? ""));
  return Array.from(groups.values(), candidates => {
    const scored = candidates.filter(candidate =>
      candidate.scoreAtMs !== null && scoreablePrediction(candidate)).sort(byIssueTime);
    if (scored.length) return scored[0];
    const scoreable = candidates.filter(scoreablePrediction).sort(byIssueTime);
    if (scoreable.length) return scoreable[0];
    return candidates.slice().sort(byIssueTime)[0];
  });
}

function summarizeSeries(
  rows: AccuracyInputRow[],
  label: string,
  kind: "market" | "shadow" | "champion",
  asOfMs: number,
) {
  const eligible = rows
    .filter(row => toEligible(row) !== null)
    .filter(row => kind === "market" ||
      activeForecastArtifact(row, asOfMs, kind === "shadow" ? "SHADOW" : "CHAMPION"))
    .map(row => toEligible(row)!);
  const metricProbability = (row: EligibleRow) =>
    kind === "market" ? row.marketUp : row.forecastUp;
  return {
    label,
    version: kind === "market" ? "DeepBook indicative · issued observations only" :
      Array.from(new Set(eligible.map(row => row.modelVersion))).join(", ") || null,
    metrics: safeMetrics(eligible, metricProbability),
    roundIds: eligible.map(row => row.roundId),
  };
}

function exclusionSummary(rows: AccuracyInputRow[], asOfMs: number) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.expiryMs > asOfMs) continue;
    const reason = classifyExclusion(row);
    if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

export function computeAccuracyPeriod(
  rows: AccuracyInputRow[],
  period: AccuracyPeriod,
  nowMs = Date.now(),
) {
  const duration = period === "daily" ? 86_400_000 :
    period === "sevenDay" ? 7 * 86_400_000 : Infinity;
  const startMs = Number.isFinite(duration) ? nowMs - duration : null;
  const uniqueRows = selectRoundPredictions(rows);
  const periodRows = uniqueRows.filter(row => row.expiryMs <= nowMs &&
    (startMs === null || row.expiryMs >= startMs));
  const scoredRows = periodRows.filter(row => {
    const eligible = toEligible(row);
    return eligible !== null && eligible.scoreAtMs <= nowMs &&
      (startMs === null || eligible.scoreAtMs >= startMs);
  });

  const market = summarizeSeries(scoredRows, "Raw DeepBook market baseline", "market", nowMs);
  const shadowRows = scoredRows.filter(row => activeForecastArtifact(row, nowMs, "SHADOW"));
  const championRows = scoredRows.filter(row => activeForecastArtifact(row, nowMs, "CHAMPION"));
  const shadow = summarizeSeries(shadowRows, "Prospective shadow challenger", "shadow", nowMs);
  const champion = summarizeSeries(championRows, "Promoted champion", "champion", nowMs);
  const marketByRound = new Map(market.roundIds.map(id => [id, id]));
  const matched = (series: { roundIds: string[] }) =>
    series.roundIds.filter(id => marketByRound.has(id));
  const shadowsMatchedIds = matched(shadow);
  const championMatchedIds = matched(champion);
  const rowById = new Map(scoredRows.map(row => [row.roundId, row]));
  const onIds = (ids: string[]) => ids
    .map(id => rowById.get(id))
    .filter((row): row is AccuracyInputRow => row !== undefined)
    .map(toEligible)
    .filter((row): row is EligibleRow => row !== null);

  const excluded = exclusionSummary(periodRows, nowMs);
  const validScored = periodRows.filter(row => toEligible(row) !== null);
  const issuedRows = periodRows.filter(row => row.predictionId && row.predictionAtMs !== null);
  const scoredTimes = validScored.map(row => row.scoreAtMs!).filter(Number.isFinite);
  const issuedTimes = issuedRows.map(row => row.predictionAtMs!).filter(Number.isFinite);

  return {
    period,
    startUtc: startMs === null ? null : new Date(startMs).toISOString(),
    endUtc: new Date(nowMs).toISOString(),
    evaluatedUniqueRounds: scoredRows.length,
    rawMarket: market.metrics,
    shadowChallenger: {
      label: shadow.label,
      versions: shadow.version,
      matchedRoundCount: shadowsMatchedIds.length,
      metrics: safeMetrics(onIds(shadowsMatchedIds), row => row.forecastUp),
      marketOnMatchedRounds: safeMetrics(onIds(shadowsMatchedIds), row => row.marketUp),
      unavailableReason: shadowsMatchedIds.length ? null :
        "No issued pre-outcome shadow-artifact probabilities have verified, persisted scores in this period.",
    },
    promotedChampion: {
      label: champion.label,
      versions: champion.version,
      matchedRoundCount: championMatchedIds.length,
      metrics: safeMetrics(onIds(championMatchedIds), row => row.forecastUp),
      marketOnMatchedRounds: safeMetrics(onIds(championMatchedIds), row => row.marketUp),
      unavailableReason: championMatchedIds.length ? null :
        "No promoted champion artifact and matched, issued pre-outcome forecasts are recorded in this period.",
    },
    calibratedMarketBaseline: {
      available: false,
      metrics: null,
      matchedRoundCount: 0,
      unavailableReason: "No separately frozen DeepBook-market calibration artifact with a pre-outcome cutoff is persisted. Retrospective calibration metrics are not reused as prospective forecasts.",
    },
    issuedActions: {
      directionalCalls: validScored.filter(row => row.action === "UP" || row.action === "DOWN").length,
      abstentions: validScored.filter(row => row.action === "HOLD").length,
      actionSource: "Persisted pre-expiry action only; probability is never converted to a directional call.",
    },
    exclusions: excluded,
    excludedRoundCount: Object.values(excluded).reduce((sum, count) => sum + count, 0),
    lastIssuedAt: issuedTimes.length ? new Date(Math.max(...issuedTimes)).toISOString() : null,
    lastScoredAt: scoredTimes.length ? new Date(Math.max(...scoredTimes)).toISOString() : null,
    horizon: {
      name: "ScoreSettled-compatible primary observation in the fixed 30–45 seconds before expiry window.",
      sameHorizonMatchedRounds: true,
    },
    provenanceLimitations: [
      "Provider freshness and wrong-market SDK source identity are not independently stored with historical probability reads; no stale-source or wrong-round counts are inferred.",
      "Action hit rate is based only on a persisted UP or DOWN action; HOLD rows are abstentions. This is not profitability.",
    ],
  };
}

export function computeAccuracyReport(
  rows: AccuracyInputRow[],
  nowMs = Date.now(),
  coverage: AccuracyDatasetCoverage = {
    lifetimeComplete: true,
    dailyComplete: true,
    sevenDayComplete: true,
  },
) {
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be a finite timestamp");
  const periodUnavailableReason = (name: string) =>
    `${name} exceeds the ${REPORT_QUERY_LIMIT.toLocaleString()}-round safe query window; no partial metrics are published.`;
  const incompletePeriods = [
    !coverage.dailyComplete && "daily",
    !coverage.sevenDayComplete && "sevenDay",
    !coverage.lifetimeComplete && "lifetime",
  ].filter((period): period is string => Boolean(period));
  // The chart cohorts are fixed, consecutive 24-hour issuance windows. A label
  // verified after its issuance window belongs to that original window, but
  // cannot be used before the verification and persisted score actually exist.
  const timelineEntries = coverage.sevenDayComplete
    ? Array.from({ length: 7 }, (_, index) => {
      const startMs = nowMs - (7 - index) * 86_400_000;
      const endMs = startMs + 86_400_000;
      const cohort = rows.filter(row => row.expiryMs >= startMs && row.expiryMs < endMs);
      const result = computeAccuracyPeriod(cohort, "lifetime", nowMs);
      return {
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        evaluatedUniqueRounds: result.evaluatedUniqueRounds,
        rawMarketBrier: result.rawMarket.brier,
        rawMarketLogLoss: result.rawMarket.logLoss,
        shadowBrier: result.shadowChallenger.matchedRoundCount
          ? result.shadowChallenger.metrics.brier : null,
        shadowMatchedMarketBrier: result.shadowChallenger.matchedRoundCount
          ? result.shadowChallenger.marketOnMatchedRounds.brier : null,
        directionalCalls: result.issuedActions.directionalCalls,
        abstentions: result.issuedActions.abstentions,
        excludedRoundCount: result.excludedRoundCount,
      };
    })
    : null;
  return {
    status: incompletePeriods.length ? "PARTIAL" : "OK",
    asOf: new Date(nowMs).toISOString(),
    scope: "Prospective issued predictions paired with independently verified settlement and persisted score only.",
    timeline: {
      kind: "rolling_24h_utc",
      entries: timelineEntries,
      unavailableReason: timelineEntries === null
        ? periodUnavailableReason("Seven-day trend") : null,
    },
    periods: {
      daily: coverage.dailyComplete ? computeAccuracyPeriod(rows, "daily", nowMs) : null,
      sevenDay: coverage.sevenDayComplete ? computeAccuracyPeriod(rows, "sevenDay", nowMs) : null,
      lifetime: coverage.lifetimeComplete ? computeAccuracyPeriod(rows, "lifetime", nowMs) : null,
    },
    unavailablePeriods: {
      daily: coverage.dailyComplete ? null : periodUnavailableReason("Daily period"),
      sevenDay: coverage.sevenDayComplete ? null : periodUnavailableReason("Seven-day period"),
      lifetime: coverage.lifetimeComplete ? null : periodUnavailableReason("Lifetime period"),
    },
    limitations: [
      "Retrospective model backtests are reported separately by /api/model and are not merged into these prospective results.",
      "Calibration intervals use 30-minute expiry-time blocks; effective sample size is the number of non-empty time blocks, not rounds.",
      ...(incompletePeriods.length
        ? [`Metrics are omitted for periods exceeding the ${REPORT_QUERY_LIMIT.toLocaleString()}-round read cap.`]
        : []),
    ],
  };
}

async function withReadOnly<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await reportPool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readReportRows(client: pg.PoolClient, asOfMs: number) {
  const { rows } = await client.query(`
    SELECT r.id AS "roundId", r.expiry_ms AS "expiryMs", r.outcome, r.quality,
      r.settlement_verified_at AS "settlementVerifiedAt", (r.settlement_price IS NOT NULL) AS "settlementPresent",
      p.id AS "predictionId", p.observed_at AS "predictionAt", p.captured_at AS "capturedAt",
      p.remaining_seconds AS "remainingSeconds", p.indicative_up AS "marketUp",
      p.forecast_up AS "forecastUp", p.model_version AS "modelVersion", p.action,
      p.scored_at AS "scoreAt", p.kind AS "scoreKind",
      EXISTS (SELECT 1 FROM btc_predict_snapshots w WHERE w.round_id=r.id
        AND w.observed_at BETWEEN to_timestamp(r.expiry_ms/1000.0)-interval '45 seconds'
          AND to_timestamp(r.expiry_ms/1000.0)-interval '30 seconds') AS "snapshotInWindow",
      EXISTS (SELECT 1 FROM btc_predict_snapshots x WHERE x.round_id=r.id
        AND x.observed_at < to_timestamp(r.expiry_ms/1000.0)) AS "hasPreExpirySnapshot",
      m.status AS "modelStatus", m.created_at AS "modelCreatedAt",
      m.trained_through AS "modelTrainedThrough", m.calibrated_at AS "modelCalibratedAt",
      (m.parameters ? 'artifact') AS "hasFrozenArtifact",
      m.parameters->'artifact' AS artifact
    FROM btc_predict_rounds r
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM (
        SELECT p0.*, s0.scored_at, s0.kind,
          COALESCE(
            p0.indicative_up BETWEEN 0 AND 1
            AND (p0.model_version NOT LIKE 'btc-shadow-logistic-v1-%'
              OR p0.forecast_up BETWEEN 0 AND 1)
            AND p0.observed_at < to_timestamp(r.expiry_ms/1000.0)
            AND p0.captured_at < to_timestamp(r.expiry_ms/1000.0),
            false
          ) AS score_eligible
        FROM btc_predict_predictions p0
        LEFT JOIN btc_predict_scores s0 ON s0.prediction_id=p0.id AND s0.round_id=p0.round_id
        WHERE p0.round_id=r.id AND p0.primary_window
      ) candidate
      ORDER BY (candidate.score_eligible AND candidate.scored_at IS NOT NULL) DESC,
        candidate.score_eligible DESC, candidate.observed_at ASC, candidate.id ASC
      LIMIT 1
    ) p ON true
    LEFT JOIN btc_predict_models m ON m.version=p.model_version
    WHERE r.expiry_ms <= $2
    ORDER BY r.expiry_ms DESC, r.id DESC LIMIT $1`,
    [REPORT_QUERY_LIMIT + 1, asOfMs]);
  const mappedRows: AccuracyInputRow[] = rows.map((row: any) => {
    const artifactInput = row.artifact;
    let artifactMatchesVersion = false;
    if (artifactInput && row.modelVersion) {
      try {
        const artifact = parseBtcArtifact(JSON.stringify(artifactInput));
        artifactMatchesVersion = artifact.modelVersion === String(row.modelVersion);
      } catch {
        artifactMatchesVersion = false;
      }
    }
    return {
    roundId: String(row.roundId),
    expiryMs: Number(row.expiryMs),
    outcome: row.outcome as Outcome,
    quality: String(row.quality),
    settlementPresent: Boolean(row.settlementPresent),
    settlementVerifiedAtMs: row.settlementVerifiedAt === null ? null :
      new Date(row.settlementVerifiedAt).getTime(),
    predictionId: row.predictionId === null ? null : String(row.predictionId),
    predictionAtMs: row.predictionAt === null ? null : new Date(row.predictionAt).getTime(),
    capturedAtMs: row.capturedAt === null ? null : new Date(row.capturedAt).getTime(),
    remainingSeconds: row.remainingSeconds === null ? null : Number(row.remainingSeconds),
    marketUp: row.marketUp === null ? null : Number(row.marketUp),
    forecastUp: row.forecastUp === null ? null : Number(row.forecastUp),
    modelVersion: row.modelVersion === null ? null : String(row.modelVersion),
    action: row.action as Action,
    scoreAtMs: row.scoreAt === null ? null : new Date(row.scoreAt).getTime(),
    scoreKind: row.scoreKind === null ? null : String(row.scoreKind),
    snapshotInWindow: Boolean(row.snapshotInWindow),
    hasPreExpirySnapshot: Boolean(row.hasPreExpirySnapshot),
    modelStatus: row.modelStatus === null ? null : String(row.modelStatus),
    modelCreatedAtMs: row.modelCreatedAt === null ? null : new Date(row.modelCreatedAt).getTime(),
    modelTrainedThroughMs: row.modelTrainedThrough === null ? null :
      new Date(row.modelTrainedThrough).getTime(),
    modelCalibratedAtMs: row.modelCalibratedAt === null ? null :
      new Date(row.modelCalibratedAt).getTime(),
    hasFrozenArtifact: Boolean(row.hasFrozenArtifact),
    artifactMatchesVersion,
    };
  });
  const hasLifetimeOverflow = mappedRows.length > REPORT_QUERY_LIMIT;
  const sampledRows = mappedRows.slice(0, REPORT_QUERY_LIMIT);
  if (!hasLifetimeOverflow) return {
    rows: sampledRows,
    coverage: {
      lifetimeComplete: true,
      dailyComplete: true,
      sevenDayComplete: true,
    } satisfies AccuracyDatasetCoverage,
  };

  const oldest = sampledRows.at(-1)!;
  const { rows: [omitted] } = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM btc_predict_rounds r
        WHERE r.expiry_ms <= $1::bigint AND r.expiry_ms >= $2::bigint
          AND (r.expiry_ms,r.id)<($3::bigint,$4::text)) AS "dailyHasOmitted",
      EXISTS (SELECT 1 FROM btc_predict_rounds r
        WHERE r.expiry_ms <= $1::bigint AND r.expiry_ms >= $5::bigint
          AND (r.expiry_ms,r.id)<($3::bigint,$4::text)) AS "sevenDayHasOmitted",
      EXISTS (SELECT 1 FROM btc_predict_rounds r
        WHERE r.expiry_ms <= $1::bigint
          AND (r.expiry_ms,r.id)<($3::bigint,$4::text)) AS "lifetimeHasOmitted"`,
  [asOfMs, asOfMs - 86_400_000, oldest.expiryMs, oldest.roundId,
    asOfMs - 7 * 86_400_000]);
  return {
    rows: sampledRows,
    coverage: {
      dailyComplete: !omitted.dailyHasOmitted,
      sevenDayComplete: !omitted.sevenDayHasOmitted,
      lifetimeComplete: !omitted.lifetimeHasOmitted,
    } satisfies AccuracyDatasetCoverage,
  };
}

/** Read the prospective accuracy dashboard without writing to the database. */
export async function accuracyReport(nowMs = Date.now()) {
  return withReadOnly(async client => {
    const dataset = await readReportRows(client, nowMs);
    return computeAccuracyReport(dataset.rows, nowMs, dataset.coverage);
  });
}

type Cursor = { collection: ExportCollection; at: string; id: string };

function validCursorTimestamp(collection: ExportCollection, at: unknown): at is string {
  if (typeof at !== "string") return false;
  if (collection === "outcomes") return /^\d{1,19}$/.test(at);
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(at) &&
    Number.isFinite(Date.parse(at));
}

function decodeCursor(encoded: string | null | undefined, collection: ExportCollection): Cursor | null {
  if (!encoded) return null;
  if (encoded.length > 512) throw new Error("Invalid pagination cursor");
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed.collection !== collection || !validCursorTimestamp(collection, parsed.at) ||
        typeof parsed.id !== "string" || parsed.id.length > 160)
      throw new Error("Cursor does not match this export");
    return parsed as Cursor;
  } catch {
    throw new Error("Invalid pagination cursor");
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function normalizeExportOptions(collection: ExportCollection, options: ExportPageOptions = {}) {
  if (!["predictions", "outcomes", "scores"].includes(collection))
    throw new Error("Unsupported export collection");
  const limit = options.limit ?? EXPORT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXPORT_MAX_LIMIT)
    throw new Error(`limit must be an integer from 1 to ${EXPORT_MAX_LIMIT}`);
  const cursor = decodeCursor(options.cursor, collection);
  return { limit, cursor };
}

async function exportRows(
  client: pg.PoolClient,
  collection: ExportCollection,
  cursor: Cursor | null,
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (collection === "predictions") {
    const { rows } = await client.query(`SELECT p.id AS "predictionId",p.round_id AS "roundId",
      p.observed_at AS "issuedAt",p.captured_at AS "capturedAt",p.remaining_seconds AS "remainingSeconds",
      to_char(p.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__cursorAt",
      p.primary_window AS "primaryWindow",p.model_version AS "modelVersion",
      p.indicative_up AS "marketUp",p.forecast_up AS "forecastUp",p.action,p.reason,
      r.outcome,r.quality,r.settlement_verified_at AS "settlementVerifiedAt"
      FROM btc_predict_predictions p JOIN btc_predict_rounds r ON r.id=p.round_id
      WHERE ($1::text IS NULL OR (p.observed_at,p.id)<($1::timestamptz,$2))
      ORDER BY p.observed_at DESC,p.id DESC LIMIT $3`,
    [cursor?.at ?? null,cursor?.id ?? null,limit+1]);
    return rows;
  }
  if (collection === "outcomes") {
    const { rows } = await client.query(`SELECT r.id AS "roundId",
      r.expiry_ms AS "expiryMs",r.expiry_ms::text AS "__cursorAt",r.reference_price AS "referencePrice",
      r.settlement_price AS "settlementPrice",r.outcome,r.quality,
      r.settlement_verified_at AS "settlementVerifiedAt"
      FROM btc_predict_rounds r
      WHERE r.settlement_price IS NOT NULL
        AND ($1::text IS NULL OR (r.expiry_ms,r.id)<($1::bigint,$2))
      ORDER BY r.expiry_ms DESC,r.id DESC LIMIT $3`,
    [cursor?.at ?? null,cursor?.id ?? null,limit+1]);
    return rows;
  }
  const { rows } = await client.query(`SELECT s.prediction_id AS "predictionId",
    s.round_id AS "roundId",s.scored_at AS "scoredAt",s.outcome,s.kind,s.brier,s.log_loss AS "logLoss",
    to_char(s.scored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__cursorAt",
    p.observed_at AS "issuedAt",p.remaining_seconds AS "remainingSeconds",
    p.model_version AS "modelVersion",p.indicative_up AS "marketUp",p.forecast_up AS "forecastUp",
    r.quality,r.settlement_verified_at AS "settlementVerifiedAt"
    FROM btc_predict_scores s JOIN btc_predict_predictions p ON p.id=s.prediction_id
    JOIN btc_predict_rounds r ON r.id=s.round_id
    WHERE ($1::text IS NULL OR (s.scored_at,s.prediction_id)<($1::timestamptz,$2))
    ORDER BY s.scored_at DESC,s.prediction_id DESC LIMIT $3`,
  [cursor?.at ?? null,cursor?.id ?? null,limit+1]);
  return rows;
}

const CSV_COLUMNS: Record<ExportCollection, string[]> = {
  predictions: ["predictionId","roundId","issuedAt","capturedAt","remainingSeconds",
    "primaryWindow","modelVersion","marketUp","forecastUp","action","reason",
    "outcome","quality","settlementVerifiedAt"],
  outcomes: ["roundId","expiryMs","referencePrice","settlementPrice","outcome",
    "quality","settlementVerifiedAt"],
  scores: ["predictionId","roundId","scoredAt","outcome","kind","brier","logLoss",
    "issuedAt","remainingSeconds","modelVersion","marketUp","forecastUp","quality",
    "settlementVerifiedAt"],
};

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(collection: ExportCollection, rows: Record<string, unknown>[]): string {
  const columns = CSV_COLUMNS[collection];
  return [columns.join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))]
    .join("\r\n") + "\r\n";
}

/**
 * Returns a bounded page and CSV with an opaque, collection-bound cursor.
 * Pass the returned nextCursor unchanged to fetch subsequent pages.
 */
export async function accuracyExport(
  collection: ExportCollection,
  options: ExportPageOptions = {},
) {
  const { limit, cursor } = normalizeExportOptions(collection, options);
  return withReadOnly(async client => {
    const rows = await exportRows(client, collection, cursor, limit);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    const idField = collection === "predictions" ? "predictionId" :
      collection === "outcomes" ? "roundId" : "predictionId";
    const at = last?.__cursorAt;
    if (hasMore && (!last || !validCursorTimestamp(collection, at)))
      throw new Error("Unable to construct export pagination cursor");
    const nextCursor = hasMore && last
      ? encodeCursor({ collection, at: String(at), id: String(last[idField]) }) : null;
    const publicRows = pageRows.map(({ __cursorAt: _cursorAt, ...row }) => row);
    return {
      collection,
      count: pageRows.length,
      limit,
      hasMore,
      nextCursor,
      rows: publicRows,
      csv: toCsv(collection, publicRows),
      pii: "No account, wallet, email, phone, or user-identifying fields are selected.",
    };
  });
}