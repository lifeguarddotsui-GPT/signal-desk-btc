import { discover, indicative, readSettlement, type Market } from "./source";
import { chartSeries, latestComparison } from "./chart";
import { chartPoints, healthStats, history, lastShadowModel, lastShadowTrainingAt, markHeartbeat, markSettlementAttempt, modelRows, pendingSettlements, prospectiveScores, recentPredictions, recordSettlement, saveEvidence, saveRound, saveShadowModel, scoreSettled, withCollectorLease } from "./store";
import { recommendation } from "./engine";
import { buildShadowArtifact, evaluateShadow } from "./model";
import { evidenceContext } from "./evidence";
import { advisorForLive } from "./advisor";
import { isCurrentUnexpiredRound, nextPrimaryCaptureDelayMs, primaryDecisionWindow } from "./policy";

type Quote = { up: number; down: number; asOf: string; source: string };
type Comparison = { price: number; asOf: string; source: string };
let state: { round: Market | null; indicative: Quote | null; comparison: Comparison | null;
  updatedAt: string | null; marketStatus: string; priceStatus: string; comparisonStatus: string; reason: string } = {
    round: null, indicative: null, comparison: null, updatedAt: null,
    marketStatus: "WAITING", priceStatus: "WAITING", comparisonStatus: "WAITING", reason: "Waiting for the first public on-chain read.",
  };
let busy = false;
let timer: NodeJS.Timeout;
let settlementBusy = false;
let lastTrainingCheck = 0;
let primaryCaptureTimer: NodeJS.Timeout | undefined;
let primaryCaptureRoundId: string | null = null;
let primaryCaptureBusy = false;

function schedulePrimaryCapture(): void {
  const round = state.round;
  if (!round) {
    if (primaryCaptureTimer) clearTimeout(primaryCaptureTimer);
    primaryCaptureTimer = undefined;
    primaryCaptureRoundId = null;
    return;
  }
  if (primaryCaptureRoundId !== round.id) {
    if (primaryCaptureTimer) clearTimeout(primaryCaptureTimer);
    primaryCaptureTimer = undefined;
    primaryCaptureRoundId = round.id;
  }
  if (primaryCaptureTimer || primaryCaptureBusy) return;
  const delay = nextPrimaryCaptureDelayMs(round.expiryMs, Date.now());
  if (delay === null) {
    primaryCaptureRoundId = null;
    return;
  }
  const roundId = round.id;
  primaryCaptureTimer = setTimeout(() => {
    primaryCaptureTimer = undefined;
    primaryCaptureBusy = true;
    void withCollectorLease(async () => {
      const active = state.round;
      if (!active || !isCurrentUnexpiredRound(roundId, round.expiryMs, active, Date.now()) ||
          active.expiryMs - Date.now() <= 30_000) return;
      try {
        const quote = await indicative(active);
        const observedAt = new Date().toISOString();
        if (!isCurrentUnexpiredRound(roundId, round.expiryMs, state.round, Date.parse(observedAt)) ||
            !primaryDecisionWindow(Date.parse(observedAt), round.expiryMs)) return;
        const comparison = latestComparison();
        const persistRound = state.round;
        if (!persistRound || !isCurrentUnexpiredRound(roundId, round.expiryMs, persistRound, Date.now())) return;
        const snapshotId = await saveEvidence(persistRound, {
          chosen: persistRound,
          indicative: quote,
          comparison,
          captureStage: "targeted-primary-window",
        }, observedAt, quote, comparison);
        if (!snapshotId)
          console.info("[btc] primary-window capture deduplicated", roundId);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 120) : "unknown error";
        console.warn("[btc] primary-window capture failed", message);
        await markHeartbeat({ error: `Primary capture: ${message}` });
      }
    }, "primary")
      .catch(error => console.error("[btc] primary capture lease failed", error))
      .finally(() => {
        primaryCaptureBusy = false;
        schedulePrimaryCapture();
      });
  }, delay);
  primaryCaptureTimer.unref();
}

export async function poll() {
  if (busy) return;
  busy = true;
  try {
    const discovery = await discover();
    const round = discovery.market;
    const quote = await Promise.allSettled([round ? indicative(round) : Promise.resolve(null)]);
    const observedAt = new Date().toISOString();
    const q = quote[0].status === "fulfilled" ? quote[0].value : null;
    const c = latestComparison();
    state = {
      round, indicative: q, comparison: c, updatedAt: observedAt,
      marketStatus: round ? "LIVE_ONCHAIN_READ" : "NO_IDENTIFIABLE_ONE_MINUTE_ROUND",
      priceStatus: q ? "INDICATIVE" : "UNAVAILABLE",
      comparisonStatus: c ? "CURRENT" : "UNAVAILABLE",
      reason: !round ? "No identifiable current BTC one-minute round in the SDK active-market list."
        : !round.referencePrice ? "On-chain round reference price has not been recorded yet."
        : !q ? `Indicative price unavailable${quote[0].status === "rejected" ? ": " + String(quote[0].reason).slice(0, 140) : ""}.`
        : "Indicative on-chain probability is not an executable purchase quote.",
    };
    schedulePrimaryCapture();
    if (round) {
      try {
        await saveRound(round, observedAt);
        await saveEvidence(round, { markets: discovery.all.map(m => ({
          id: m.id, expiryMs: String(m.expiryMs), referencePrice: m.referencePrice, mintPaused: m.mintPaused,
        })), chosen: round, indicative: q, comparison: c }, observedAt, q, c);
      } catch (error) {
        state.reason += ` Prospective storage failed: ${error instanceof Error ? error.message.slice(0, 100) : "unknown error"}.`;
        state.marketStatus = "STORAGE_ERROR";
      }
    }
    await markHeartbeat({ marketAt: round ? observedAt : undefined, roundId: round?.id,
      error: quote[0].status === "rejected" ? `DeepBook indicative: ${String(quote[0].reason).slice(0, 120)}`
        : !c ? "Coinbase comparison capture unavailable" : undefined });
  } catch (error) {
    state = { ...state, round: null, indicative: null, updatedAt: new Date().toISOString(),
      marketStatus: "UNAVAILABLE", priceStatus: "UNAVAILABLE",
      reason: `Official market read failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}.` };
    schedulePrimaryCapture();
    try { await markHeartbeat({ error: state.reason }); } catch (storageError) {
      console.error("[btc] heartbeat storage failed", storageError);
    }
  } finally { busy = false; }
}
export async function reconcile() {
  if (settlementBusy) return;
  settlementBusy = true;
  try {
    for (const row of await pendingSettlements()) {
      try {
        await markSettlementAttempt(row.id);
        const price = await readSettlement(row.id);
        if (price !== null) await recordSettlement(row.id, price, row.reference_price === null ? null : Number(row.reference_price));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 100) : "unknown";
        console.warn("[btc] settlement read pending", message);
        await markHeartbeat({ error: `Settlement: ${message}` });
      }
    }
    await scoreSettled();
  } finally { settlementBusy = false; }
}
async function trainShadowIfDue() {
  if (Date.now() - lastTrainingCheck < 60 * 60_000) return;
  lastTrainingCheck = Date.now();
  const previousTraining = await lastShadowTrainingAt();
  if (previousTraining &&
    new Date(previousTraining).toISOString().slice(0,10) === new Date().toISOString().slice(0,10))
    return;
  const rows = await modelRows();
  const result = evaluateShadow(rows);
  if (result.status !== "shadow" || !result.challenger) return;
  const artifact = buildShadowArtifact(rows);
  const cutoff = new Date(rows.at(-1)!.expiryMs).toISOString();
  // One immutable, validated shadow artifact may be saved per successful UTC
  // daily run. Saving or evaluating it never promotes a champion.
  await saveShadowModel(artifact, cutoff, result);
}
export function startCapture() {
  const tick = () => void withCollectorLease(async () => {
    await poll();
    await reconcile();
    await trainShadowIfDue();
  })
    .catch(error => console.error("[btc] capture", error));
  tick();
  timer = setInterval(tick, 6_000);
  timer.unref();
}
export async function live() {
  const now = Date.now();
  const stale = !state.updatedAt || now - Date.parse(state.updatedAt) > 14_000;
  const expired = !stale && state.round && state.round.expiryMs <= now;
  const active = !stale && state.round && state.round.expiryMs > now && state.round.startMs <= now &&
    !state.round.mintPaused && state.round.referencePrice !== null;
  const round = active ? state.round : null;
  const quoteTime = state.indicative ? Date.parse(state.indicative.asOf) : NaN;
  const quote = round && state.indicative && Number.isFinite(quoteTime) &&
    quoteTime >= round.startMs && quoteTime <= now && now - quoteTime < 14_000
    ? state.indicative : null;
  const latest = latestComparison();
  const comparison = latest ?? (state.comparison && now - Date.parse(state.comparison.asOf) < 20_000
    ? state.comparison : null);
  const points = chartSeries(await chartPoints(), now);
  const context = evidenceContext({
    now, hasRound: !!round, referencePrice: round?.referencePrice ?? null,
    indicativeUp: quote?.up ?? null, comparisonPrice: comparison?.price ?? null,
    points: points.filter((point): point is Exclude<typeof point, { price: null }> => point.price !== null),
    promotedModel: false,
  });
  const decision = recommendation({
    hasRound: !!round, expiryMs: round?.expiryMs, now, referencePrice: round?.referencePrice,
    roundAsOf: round ? state.updatedAt : null,
    estimatedUp: null, executableUp: null, executableDown: null, payoutAfterFees: null,
    calibratedSamples: 0, edgeThreshold: .05,
  });
  return {
    serverTime: new Date().toISOString(), status: round ? "LIVE" : stale ? "STALE" : expired ? "SETTLING" : "HOLD",
    reason: stale ? "On-chain market read is stale; no live round can be certified."
      : expired ? "Last observed round expired; waiting for verified settlement and a new eligible round."
      : !round ? state.reason || "No eligible live round is available." : state.reason,
    round, indicative: quote, comparison, oraclePrice: null,
    forecast: null,
    advisor: advisorForLive({ now, expiryMs: round?.expiryMs ?? null,
      roundStartMs: round?.startMs ?? null, indicative: quote }),
    confidence: { label: "Unrated", reasons: [
      "No promoted model has passed multi-day independent validation.",
      "Indicative on-chain prices are not executable quotes or a reliability score.",
    ] },
    ...context, points,
    recommendation: { action: decision.action, reason: decision.reason },
    decisionAudit: decision.audit,
    health: { market: stale ? "STALE" : state.marketStatus, price: quote ? "INDICATIVE" : "UNAVAILABLE",
      comparison: comparison ? "CURRENT" : "UNAVAILABLE", storage: state.marketStatus === "STORAGE_ERROR" ? "ERROR" : "ACTIVE" },
  };
}
export async function historyResponse(page = 1, pageSize = 20) {
  const [rows, stats] = await Promise.all([history(page,pageSize),healthStats()]);
  return { rows,page,pageSize,total:stats.coverage.observed,
    totalPages:Math.max(1,Math.ceil(stats.coverage.observed/pageSize)),coverage: {
    ...stats.coverage, missingHistory: true,
    reason: "Prospective observations only. The SDK does not enumerate historical settled rounds; gaps show unknown publication, not confirmed missing markets.",
  } };
}
export async function modelResponse() {
  const [stats, shadow, shadowRows, scored] = await Promise.all([
    healthStats(),lastShadowModel(),modelRows(),prospectiveScores()]);
  const result = evaluateShadow(shadowRows);
  const baseline = result.baselines;
  const retrospectiveBaselines = [
    baseline.fiftyFifty ? { name: "50/50 (retrospective test)", ...baseline.fiftyFifty } : null,
    baseline.onChainIndicative ? { name: "On-chain indicative (retrospective test)", ...baseline.onChainIndicative } : null,
    baseline.deepBookCalibrated ? {
      name: "Calibrated DeepBook (shadow-only retrospective test)",
      ...baseline.deepBookCalibrated.metrics,
      calibrationCount: baseline.deepBookCalibrated.calibrationCount,
      method: baseline.deepBookCalibrated.method,
    } : null,
  ].filter(Boolean);
  const split = result.evaluated.split;
  const windowLabel = (v: {startUtc:string|null;endUtc:string|null;count:number}) =>
    v.startUtc && v.endUtc ? `${v.startUtc} – ${v.endUtc} · n=${v.count}` : "Not available";
  const observedTimes = shadowRows.map(row => row.observedMs).sort((a, b) => a - b);
  const elapsedHistoryHours = observedTimes.length > 1
    ? (observedTimes.at(-1)! - observedTimes[0]) / 3_600_000 : 0;
  const maximumGapHours = observedTimes.length > 1
    ? observedTimes.reduce((maximum, time, index) =>
      index ? Math.max(maximum, (time - observedTimes[index - 1]) / 3_600_000) : maximum, 0)
    : null;
  return {
    status: shadow ? "SHADOW_ONLY" : retrospectiveBaselines.length ? "BASELINES_ONLY" : "INSUFFICIENT_HISTORY",
    reason: `${result.reason}. Offline historical snapshots are not proof of a prospective forecast. No promoted calibrated model, verified economic terms, or profitability evaluation is available.`,
    historicalRows: stats.coverage.observed, eligible: stats.coverage.eligible,
    trainingRequirements: {
      eligibleRounds: shadowRows.length, minimumRounds: 300,
      elapsedHistoryHours, minimumElapsedHours: 48,
      maximumGapHours, maximumAllowedGapHours: 12,
      eligibleForShadow: result.eligible,
    },
    prospectiveEligible: stats.coverage.prospectiveEligible,
    evaluated: stats.coverage.evaluated, retrospectiveEligible: shadowRows.length,
    champion: null, challenger: shadow ? {
      version: shadow.version, trainedThrough: shadow.trainedThrough,
      calibratedAt: shadow.calibratedAt, metrics: shadow.metrics?.challenger?.metrics,
    } : null,
    lastTrainingAt: stats.worker?.lastTrainingAt ?? null,
    lastCalibrationAt: shadow?.calibratedAt ?? null,
    shadowEvaluation: shadow?.metrics ?? { ...result, challenger:null },
    windows: { train:windowLabel(split.training),calibration:windowLabel(split.calibration),test:windowLabel(split.test) },
    sampleCount: result.evaluated.count,
    baselines: scored, retrospectiveBaselines,
  };
}
export async function healthResponse() {
  const stats = await healthStats();
  const worker = stats.worker;
  const now = Date.now();
  const lagSeconds = worker?.lastTickAt ? Math.max(0,Math.round((now-new Date(worker.lastTickAt).getTime())/1000)) : null;
  const pipeline = stats.pipeline;
  const ageSeconds = (at: string | null) => at ? Math.max(0,Math.round((now-Date.parse(at))/1000)) : null;
  const alerts: Array<{ id: string; severity: "WARNING" | "CRITICAL"; message: string }> = [];
  if (pipeline.verifiedSettlements15m > 0 && pipeline.qualifiedPredictions15m === 0)
    alerts.push({ id: "primary-window-no-qualified-captures", severity: "CRITICAL",
      message: "Verified settlements continued, but no probability-qualified primary-window prediction was captured in the last 15 minutes. The 45–30s scoring window is unchanged; targeted retries are active." });
  if (pipeline.settlementsWithoutPrimary15m > 0)
    alerts.push({ id: "missed-primary-window", severity: "WARNING",
      message: `${pipeline.settlementsWithoutPrimary15m} recently verified round(s) have no immutable prediction captured in the strict primary window.` });
  if (pipeline.settlementsWithoutProbability15m > 0)
    alerts.push({ id: "primary-probability-missing", severity: "WARNING",
      message: `${pipeline.settlementsWithoutProbability15m} recently verified round(s) had a primary-window record, but none has a valid indicative probability.` });
  if (pipeline.qualifiedUnscoredBacklog > 0 && (ageSeconds(pipeline.oldestUnscoredAt) ?? 0) > 120)
    alerts.push({ id: "verified-score-backlog", severity: "CRITICAL",
      message: `${pipeline.qualifiedUnscoredBacklog} probability-qualified verified round(s) remain unscored; oldest backlog is ${ageSeconds(pipeline.oldestUnscoredAt)} seconds.` });
  if (pipeline.pendingSettlementCount > 0 &&
      (pipeline.oldestPendingSettlementExpiry === null ||
       now - pipeline.oldestPendingSettlementExpiry > 120_000))
    alerts.push({ id: "settlement-backlog", severity: "WARNING",
      message: `${pipeline.pendingSettlementCount} expired round(s) remain unsettled; reconcile retries are active.` });
  const recentErrorStages = Array.from(new Set(pipeline.recentErrors.map((error: { message: string }) =>
    error.message.startsWith("Primary capture:") ? "primary_capture"
      : error.message.startsWith("Settlement:") ? "settlement"
        : error.message.startsWith("DeepBook indicative:") ? "indicative"
          : error.message.startsWith("Official market read failed:") ? "discovery"
            : error.message.startsWith("Coinbase") ? "comparison"
              : /column|relation|constraint|schema|sqlstate/i.test(error.message) ? "persistence" : "collector")));
  const recentErrors = pipeline.recentErrors.map((error: { message: string; recordedAt: string }) => ({
    ...error,
    message: error.message
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[endpoint]")
      .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "[redacted]"),
  }));
  return {
    worker: { ...worker, lagSeconds,
      status: lagSeconds !== null && lagSeconds <= 18 ? "ok" : "stalled" },
    coverage: stats.coverage,
    pipeline: {
      policy: { primaryWindow: "30–45 seconds remaining; unchanged", retryIntervalMs: 2_500,
        targetedBucketMs: 3_000, standardBucketMs: 15_000 },
      counters: {
        observedRounds: Number(stats.coverage.observed),
        storedSnapshots: pipeline.snapshotCount,
        validProbabilitySnapshots: pipeline.validProbabilitySnapshots,
        primaryAttempts: pipeline.primaryAttempts,
        probabilityQualifiedPrimary: pipeline.qualifiedPrimaryPredictions,
        scoredPredictions: Number(stats.coverage.evaluated),
        verifiedSettlements: Number(stats.coverage.settled),
      },
      stages: {
        discovery: { lastSuccessAt: worker?.lastMarketAt ?? null,
          lastRoundId: worker?.lastRoundId ?? null,
          status: ageSeconds(worker?.lastMarketAt ?? null) !== null &&
            ageSeconds(worker?.lastMarketAt ?? null)! <= 18 ? "ACTIVE" : "STALE" },
        observation: { lastSuccessAt: pipeline.lastSnapshotAt, status: ageSeconds(pipeline.lastSnapshotAt) !== null &&
          ageSeconds(pipeline.lastSnapshotAt)! <= 30 ? "ACTIVE" : "STALE" },
        primaryPrediction: {
          lastAttemptAt: pipeline.lastPrimaryAttemptAt,
          lastProbabilityQualifiedAt: pipeline.lastQualifiedPredictionAt,
          attemptsLast15m: pipeline.primaryAttempts15m,
          qualifiedLast15m: pipeline.qualifiedPredictions15m,
          verifiedSettlementsLast15m: pipeline.verifiedSettlements15m,
          status: alerts.some(alert => alert.id === "primary-window-no-qualified-captures")
            ? "DEGRADED" : "MONITORING",
        },
        settlement: {
          lastSuccessAt: worker?.lastSettlementAt ?? null,
          pending: pipeline.pendingSettlementCount,
          oldestExpiryAt: pipeline.oldestPendingSettlementExpiry === null
            ? null : new Date(pipeline.oldestPendingSettlementExpiry).toISOString(),
          oldestBacklogAgeSeconds: pipeline.oldestPendingSettlementExpiry === null ? null
            : Math.max(0, Math.floor((now-pipeline.oldestPendingSettlementExpiry)/1000)),
          status: alerts.some(alert => alert.id === "settlement-backlog") ? "BACKLOGGED" : "MONITORING",
        },
        scoring: {
          lastSuccessAt: pipeline.lastScoreAt,
          lastWorkerSuccessAt: worker?.lastEvaluationAt ?? null,
          unscoredQualifiedRounds: pipeline.qualifiedUnscoredBacklog,
          oldestUnscoredAt: pipeline.oldestUnscoredAt,
          status: alerts.some(alert => alert.id === "verified-score-backlog") ? "BACKLOGGED" : "CURRENT",
        },
        training: { lastSuccessAt: worker?.lastTrainingAt ?? null,
          eligibleRounds: Number(stats.coverage.eligible), status: "SHADOW_ONLY" },
      },
      exclusions: {
        missingProbability: pipeline.missingProbabilityPredictions,
        missingReference: pipeline.missingReferencePredictions,
        missingReferenceSettlements: Number(stats.coverage.missingReferenceSettlements),
        equalityRuleUnverifiedSettlements: Number(stats.coverage.equalityUnverifiedSettlements),
        staleInputTimestamp: pipeline.staleInputPredictions,
        wrongRoundSnapshotLink: pipeline.wrongRoundPredictions,
        noPrimaryWindowRecordInRecentVerifiedRounds: pipeline.settlementsWithoutPrimary15m,
        primaryRecordWithoutValidProbabilityInRecentVerifiedRounds: pipeline.settlementsWithoutProbability15m,
      },
      alertCount: alerts.length,
      alerts,
      recentErrorStages,
      recentErrors,
    },
    lastSettlementAt: worker?.lastSettlementAt ?? null,
    lastEvaluatedAt: worker?.lastEvaluationAt ?? null,
    lastQuoteAt: stats.coverage.lastQuoteAt ?? null,
    quoteAgeSeconds: stats.coverage.lastQuoteAt ?
      Math.max(0,Math.round((Date.now()-new Date(stats.coverage.lastQuoteAt).getTime())/1000)) : null,
    ingestionLagSeconds: stats.coverage.lastObservationAt ?
      Math.max(0,Math.round((Date.now()-new Date(stats.coverage.lastObservationAt).getTime())/1000)) : null,
    newestCapturedRoundId: worker?.lastRoundId ?? null,
    warning: "Autoscale deployments can sleep. A recent heartbeat proves activity now, not uninterrupted collection while idle.",
  };
}
export async function predictionsResponse(limit = 20) {
  return { rows: await recentPredictions(limit) };
}