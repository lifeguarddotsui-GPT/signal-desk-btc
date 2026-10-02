import {
  WATERX_RESEARCH_POLICY as POLICY,
  type ResearchDiagnostic, type ResearchInterval,
} from "../../shared/waterx-research";
import {
  getResearchHorizonEvaluations, getResearchLifecycleState, getResearchLiveObservation,
  getResearchLifecycleDiagnostics,
  type ExactResearchRound, type LifecycleDb,
} from "./research-lifecycle";
import { researchSchemaMissing } from "./research-store";

/** These are after-label diagnostics, never inputs to a frozen prediction. */
export type ResearchAudit = {
  sideCalibration: {
    side: "UP" | "DOWN"; n: number; correctN: number;
    meanProbability: number | null; observedWinRate: number | null;
    brier: number | null; logLoss: number | null;
  }[];
  featureMistakes: { feature: string; n: number; incorrectN: number }[];
  entryEvaluation: { status: "unavailable"; reason: string; rows: never[] };
  previousCandidate: {
    status: string; reason: string; matchedN: number;
    currentVersion?: string; previousVersion?: string;
    currentBrier?: number | null; previousBrier?: number | null; marketBrier?: number | null;
    pairedBrierDifference?: number | null;
  };
  canonicalTraining: unknown | null;
};
export const validAuditChoices = `SELECT c.*,s.correct,s.brier,s.log_loss
  FROM waterx_research_choices c
  JOIN waterx_learning_rounds l ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id
    AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
  JOIN waterx_research_scores s ON s.interval_minutes=c.interval_minutes AND s.round_id=c.round_id
  WHERE c.interval_minutes=$1 AND c.state='FROZEN' AND c.decision_at_ms >= $3
    AND c.decision_at_ms < c.expiry_ms AND c.expiry_ms <= $2
    AND l.label_status='verified' AND NOT l.settlement_disputed
    AND upper(l.outcome)=s.outcome
    AND l.settled_at>c.expiry_ms AND l.settled_at<=$2
    AND s.label_available_at<=to_timestamp($2::double precision/1000)`;

export const sideAuditSql = `WITH valid AS (${validAuditChoices})
  SELECT side,count(*) AS n,count(*) FILTER(WHERE correct) AS correct_n,
    avg(CASE WHEN side='UP' THEN probability_up ELSE probability_down END) AS mean_probability,
    avg(correct::int) AS observed_win_rate,avg(brier) AS brier,avg(log_loss) AS log_loss
  FROM valid GROUP BY side ORDER BY side`;
export const featureAuditSql = `WITH valid AS (${validAuditChoices}), contexts AS (
  SELECT c.*,COALESCE(f.feature_snapshot->'comparison',c.evidence->'comparison') AS comparison
  FROM valid c LEFT JOIN waterx_research_feature_supplements f
    ON f.interval_minutes=c.interval_minutes AND f.round_id=c.round_id
    AND f.start_ms=c.start_ms AND f.expiry_ms=c.expiry_ms AND f.decision_at_ms=c.decision_at_ms
  )
  SELECT f.feature,count(*) AS n,count(*) FILTER(WHERE NOT correct) AS incorrect_n
  FROM contexts c CROSS JOIN LATERAL (VALUES
    ('provisional_reference',c.evidence->'reference'->>'quality'='provisional'),
    ('confirmed_reference',c.evidence->'reference'->>'quality'='confirmed'),
    ('unavailable_reference',c.evidence->'reference'->>'quality'='unavailable'),
    ('complete_coinbase_features',c.comparison->>'coverage'='complete'),
    ('missing_coinbase_features',COALESCE(c.comparison->>'coverage','unavailable')<>'complete'),
    ('late_primary_lock',c.evidence->'qualityFlags' @> '["PRIMARY_LOCK_LATE_ACTUAL_TIMING"]'::jsonb),
    ('one_minute_return',jsonb_typeof(c.comparison->'return1m')='number'),
    ('three_minute_return',jsonb_typeof(c.comparison->'return3m')='number'),
    ('realized_volatility',jsonb_typeof(c.comparison->'realizedVolatility')='number')
  ) AS f(feature,present) WHERE f.present GROUP BY f.feature ORDER BY f.feature`;

/** One missing eligible final is actionable even after thousands of successes. */
export const diagnosticsSql = `SELECT p.round_id,p.start_ms,p.expiry_ms,
    p.primary_lock_seconds,c.state,c.side,s.round_id AS scored_round,
    l.label_status,l.settlement_disputed,l.outcome,
    extract(epoch FROM l.first_verified_at)*1000 AS label_available_ms,
    o.observed_at_ms AS latest_valid_input_ms,o.captured_at
  FROM waterx_research_round_policy p
  LEFT JOIN waterx_research_live_observations o ON o.interval_minutes=p.interval_minutes
    AND o.round_id=p.round_id AND o.start_ms=p.start_ms AND o.expiry_ms=p.expiry_ms
  LEFT JOIN waterx_research_choices c ON c.interval_minutes=p.interval_minutes
    AND c.round_id=p.round_id AND c.start_ms=p.start_ms AND c.expiry_ms=p.expiry_ms
  LEFT JOIN waterx_research_scores s ON s.interval_minutes=p.interval_minutes AND s.round_id=p.round_id
  LEFT JOIN waterx_learning_rounds l ON l.interval_minutes=p.interval_minutes
    AND l.round_id=p.round_id AND l.start_ms=p.start_ms AND l.expiry_ms=p.expiry_ms
  WHERE p.interval_minutes=$1 AND p.expiry_ms<=$2 AND p.expiry_ms>=$3
  ORDER BY p.expiry_ms DESC LIMIT 200`;

export function diagnoseResearchRows(
  rows: Record<string, unknown>[], interval: ResearchInterval, now: number,
  latestObservedMs: number | null,
): ResearchDiagnostic[] {
  const failures = new Map<string, ResearchDiagnostic>();
  const add = (code: string, row: Record<string, unknown> | null, reason: string) => {
    const old = failures.get(code);
    if (old) old.count = (old.count ?? 1) + 1;
    else failures.set(code, { code, roundId: row ? String(row.round_id) : null, reason, count: 1 });
  };
  for (const r of rows) {
    const expiry = Number(r.expiry_ms);
    const validInput = r.latest_valid_input_ms == null ? null : Number(r.latest_valid_input_ms);
    if (r.state !== "FROZEN") {
      const timely = validInput !== null && validInput >= expiry-Number(r.primary_lock_seconds)*1000
        && validInput < expiry;
      add(timely ? "ELIGIBLE_ROUND_MISSING_FINAL" : "OBSERVED_ROUND_MISSING_FINAL", r,
        timely ? "Valid pre-expiry primary-window probabilities were observed, but no immutable UP/DOWN final exists. Collector/persistence failure; never backfill."
          : "An observed round expired without a final choice. No valid primary-window input is proven; inspect collector gaps and rejected input.");
    } else if (r.settlement_disputed === true || r.label_status === "withheld") {
      add("SETTLEMENT_WITHDRAWN", r, "The final prediction is retained, but disputed/withheld settlement is excluded from active evaluation and training.");
    } else if (r.label_status === "verified" && r.scored_round == null
      && r.label_available_ms != null && now-Number(r.label_available_ms)>60_000) {
      add("VERIFIED_CHOICE_NOT_SCORED", r, "An exact-round verified outcome is available, but the frozen choice has not been scored within one minute.");
    } else if (r.label_status !== "verified" && now-expiry>interval*120_000) {
      add("SETTLEMENT_OVERDUE", r, "A frozen prediction remains without a verified outcome more than two round durations after expiry; no result is guessed.");
    }
  }
  if (latestObservedMs !== null && now-latestObservedMs>60_000)
    add("COLLECTOR_STALLED", null, "Research previously received valid live data, but its persisted observation heartbeat is now more than 60 seconds old.");
  return Array.from(failures.values());
}

const count = (v: unknown) => Number(v ?? 0);
const metric = (v: unknown) => v == null ? null : Number(v);
export const previousCandidateSql = `WITH versions AS (
    SELECT artifact->>'version' AS version,finished_at
    FROM waterx_research_daily_runs
    WHERE interval_minutes=$1 AND status='evaluated' AND artifact IS NOT NULL
      AND finished_at<=to_timestamp($2::double precision/1000)
    ORDER BY finished_at DESC LIMIT 2
  ), selected AS (
    SELECT (array_agg(version ORDER BY finished_at DESC))[1] AS current_version,
      (array_agg(version ORDER BY finished_at DESC))[2] AS previous_version FROM versions
  ), pairs AS (
    SELECT a.probability_up AS current_probability,b.probability_up AS previous_probability,
      a.baseline_probability_up AS market_probability,(upper(l.outcome)='UP')::int AS y
    FROM selected v JOIN waterx_research_shadow_predictions a ON a.artifact_version=v.current_version
      AND a.interval_minutes=$1
    JOIN waterx_research_shadow_predictions b ON b.artifact_version=v.previous_version
      AND b.interval_minutes=a.interval_minutes AND b.round_id=a.round_id
      AND b.decision_at_ms=a.decision_at_ms
    JOIN waterx_research_choices c ON c.interval_minutes=a.interval_minutes AND c.round_id=a.round_id
      AND c.decision_at_ms=a.decision_at_ms
    JOIN waterx_learning_rounds l ON l.interval_minutes=c.interval_minutes AND l.round_id=c.round_id
      AND l.start_ms=c.start_ms AND l.expiry_ms=c.expiry_ms
    WHERE c.state='FROZEN' AND l.label_status='verified' AND NOT l.settlement_disputed
      AND upper(l.outcome) IN ('UP','DOWN') AND l.settled_at>c.expiry_ms AND l.settled_at<=$2
      AND l.first_verified_at<=to_timestamp($2::double precision/1000)
      AND a.observed_at_ms<c.expiry_ms AND b.observed_at_ms<c.expiry_ms
      AND a.observed_at_ms<=$2 AND b.observed_at_ms<=$2 AND c.decision_at_ms>=$3
  )
  SELECT v.current_version,v.previous_version,count(p.y) AS matched_n,
    avg((p.current_probability-p.y)^2) AS current_brier,
    avg((p.previous_probability-p.y)^2) AS previous_brier,
    avg((p.market_probability-p.y)^2) AS market_brier,
    avg((p.current_probability-p.y)^2-(p.previous_probability-p.y)^2) AS paired_difference
  FROM selected v LEFT JOIN pairs p ON true GROUP BY v.current_version,v.previous_version`;
const cache = new Map<ResearchInterval, { expires: number; promise: Promise<Awaited<ReturnType<typeof auditSummary>>> }>();
async function auditSummary(db: LifecycleDb, interval: ResearchInterval, now: number) {
  const parameters = [interval, now, now-POLICY.trainingLookbackDays*86_400_000];
  const [sides, features, diagnosticRows, heartbeat, horizons, daily, paired, captureDiagnostics] = await Promise.all([
    db.query(sideAuditSql, parameters), db.query(featureAuditSql, parameters),
    db.query(diagnosticsSql, parameters),
    db.query(`SELECT max(observed_at_ms) AS latest_ms FROM waterx_research_live_observations WHERE interval_minutes=$1`, [interval]),
    getResearchHorizonEvaluations(db, interval),
    db.query(`SELECT report,status,scheduled_day FROM waterx_research_daily_runs
      WHERE interval_minutes=$1 ORDER BY scheduled_day DESC LIMIT 2`, [interval]),
    db.query(previousCandidateSql,parameters),
    getResearchLifecycleDiagnostics(db,interval),
  ]);
  const latest = daily.rows[0]?.report as Record<string, unknown> | undefined;
  const reports = daily.rows.map(r => r.report as Record<string, unknown> | null);
  const availableCandidates = reports.filter(r => r?.shadowArtifact || (r?.canonicalTraining as Record<string, unknown> | undefined)?.baselineArtifact).length;
  const pair=paired.rows[0];
  const matched=count(pair?.matched_n);
  const audit: ResearchAudit = {
    sideCalibration: sides.rows.map(r => ({
      side: r.side as "UP" | "DOWN", n: count(r.n), correctN: count(r.correct_n),
      meanProbability: metric(r.mean_probability), observedWinRate: metric(r.observed_win_rate),
      brier: metric(r.brier), logLoss: metric(r.log_loss),
    })),
    featureMistakes: features.rows.map(r => ({ feature: String(r.feature), n: count(r.n), incorrectN: count(r.incorrect_n) })),
    entryEvaluation: {
      status: "unavailable", rows: [],
      reason: "No verified all-in $5 entry receipts, costs, or qualified serving model are available. Cyan/violet entry profitability is withheld; every research prediction is still scored independently.",
    },
    previousCandidate: {
      status: matched>0 ? "matched-research-only" : availableCandidates < 2 ? "insufficient-candidates" : "awaiting-matched-forward-evidence",
      matchedN: matched,
      currentVersion: pair?.current_version == null ? undefined : String(pair.current_version),
      previousVersion: pair?.previous_version == null ? undefined : String(pair.previous_version),
      currentBrier: metric(pair?.current_brier), previousBrier: metric(pair?.previous_brier),
      marketBrier: metric(pair?.market_brier), pairedBrierDifference: metric(pair?.paired_difference),
      reason: matched>0
        ? `${matched} matched prospective forecasts: current Brier ${metric(pair?.current_brier)?.toFixed(4)}, previous ${metric(pair?.previous_brier)?.toFixed(4)}, market ${metric(pair?.market_brier)?.toFixed(4)}. Research only; no automatic promotion or production-horizon selection.`
        : availableCandidates < 2
        ? `The last two daily attempts contain ${availableCandidates} eligible candidate artifact(s). No claim that today's candidate beats yesterday's is possible.`
        : "Two research candidates exist, but no matched prospective previous-versus-current comparison is recorded. Held-out training performance is not a forward improvement claim.",
    },
    canonicalTraining: latest?.canonicalTraining ?? null,
  };
  const diagnostics: ResearchDiagnostic[]=[
    ...diagnoseResearchRows(diagnosticRows.rows, interval, now, metric(heartbeat.rows[0]?.latest_ms)),
    ...captureDiagnostics.slice(0,20).map(r=>({...r,severity:"info" as const})),
  ];
  return { ...audit, horizonEvaluation: horizons, diagnostics };
}

export async function getResearchAudit(db: LifecycleDb, interval: ResearchInterval, now: number, round: ExactResearchRound | null) {
  try {
    let existing = cache.get(interval);
    if (!existing || existing.expires<=now) {
      const promise = auditSummary(db, interval, now);
      existing = { expires: now+10_000, promise };
      cache.set(interval, existing);
      void promise.catch(() => { if(cache.get(interval)?.promise===promise) cache.delete(interval); });
    }
    const [summary, lifecycle, liveProbabilities] = await Promise.all([
      existing.promise,
      round ? getResearchLifecycleState(db, round) : null,
      round ? getResearchLiveObservation(db, round, now) : null,
    ]);
    return { ...summary, ...(lifecycle ? { lifecycle } : {}), ...(liveProbabilities ? { liveProbabilities } : {}) };
  } catch (error) {
    if (!researchSchemaMissing(error)) throw error;
    return { diagnostics: [{
      code: "LIFECYCLE_SCHEMA_UNAVAILABLE", roundId: null,
      reason: "Reviewed lifecycle migration is not installed; persisted lifecycle, live heartbeat, and alternate-horizon audits cannot be verified.",
    }] as ResearchDiagnostic[] };
  }
}