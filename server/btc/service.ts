import { comparisonBtc, discover, indicative, readSettlement, type Market } from "./source";
import { chartPoints, healthStats, history, lastShadowModel, lastShadowTrainingAt, markHeartbeat, markSettlementAttempt, modelRows, pendingSettlements, prospectiveScores, recentPredictions, recordSettlement, saveEvidence, saveRound, saveShadowModel, scoreSettled, withCollectorLease } from "./store";
import { recommendation } from "./engine";
import { buildShadowArtifact, evaluateShadow } from "./model";
import { evidenceContext } from "./evidence";

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
export async function poll() {
  if (busy) return;
  busy = true;
  try {
    const discovery = await discover();
    const round = discovery.market;
    const [quote, comparison] = await Promise.allSettled([
      round ? indicative(round) : Promise.resolve(null), comparisonBtc(),
    ]);
    const observedAt = new Date().toISOString();
    const q = quote.status === "fulfilled" ? quote.value : null;
    const c = comparison.status === "fulfilled" ? comparison.value : null;
    state = {
      round, indicative: q, comparison: c, updatedAt: observedAt,
      marketStatus: round ? "LIVE_ONCHAIN_READ" : "NO_IDENTIFIABLE_ONE_MINUTE_ROUND",
      priceStatus: q ? "INDICATIVE" : "UNAVAILABLE",
      comparisonStatus: c ? "CURRENT" : "UNAVAILABLE",
      reason: !round ? "No identifiable current BTC one-minute round in the SDK active-market list."
        : !round.referencePrice ? "On-chain round reference price has not been recorded yet."
        : !q ? `Indicative price unavailable${quote.status === "rejected" ? ": " + String(quote.reason).slice(0, 140) : ""}.`
        : "Indicative on-chain probability is not an executable purchase quote.",
    };
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
      error: quote.status === "rejected" ? `DeepBook indicative: ${String(quote.reason).slice(0, 120)}`
        : comparison.status === "rejected" ? `Coinbase comparison: ${String(comparison.reason).slice(0, 120)}` : undefined });
  } catch (error) {
    state = { ...state, round: null, indicative: null, updatedAt: new Date().toISOString(),
      marketStatus: "UNAVAILABLE", priceStatus: "UNAVAILABLE",
      reason: `Official market read failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}.` };
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
  const quote = round && state.indicative && now - Date.parse(state.indicative.asOf) < 14_000 ? state.indicative : null;
  const comparison = state.comparison && now - Date.parse(state.comparison.asOf) < 20_000 ? state.comparison : null;
  const points = await chartPoints();
  const context = evidenceContext({
    now, hasRound: !!round, referencePrice: round?.referencePrice ?? null,
    indicativeUp: quote?.up ?? null, comparisonPrice: comparison?.price ?? null,
    points, promotedModel: false,
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
  ].filter(Boolean);
  const split = result.evaluated.split;
  const windowLabel = (v: {startUtc:string|null;endUtc:string|null;count:number}) =>
    v.startUtc && v.endUtc ? `${v.startUtc} – ${v.endUtc} · n=${v.count}` : "Not available";
  return {
    status: shadow ? "SHADOW_ONLY" : retrospectiveBaselines.length ? "BASELINES_ONLY" : "INSUFFICIENT_HISTORY",
    reason: `${result.reason}. Offline historical snapshots are not proof of a prospective forecast. No promoted calibrated model, verified economic terms, or profitability evaluation is available.`,
    historicalRows: stats.coverage.observed, eligible: stats.coverage.eligible,
    trainingRequirements: {
      eligibleRounds: shadowRows.length, minimumRounds: 300,
      utcDays: new Set(shadowRows.map(row => new Date(row.observedMs).toISOString().slice(0,10))).size,
      minimumUtcDays: 2, eligibleForShadow: result.eligible,
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
  const lagSeconds = worker?.lastTickAt ? Math.max(0,Math.round((Date.now()-new Date(worker.lastTickAt).getTime())/1000)) : null;
  return {
    worker: { ...worker, lagSeconds,
      status: lagSeconds !== null && lagSeconds <= 18 ? "ok" : "stalled" },
    coverage: stats.coverage,
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