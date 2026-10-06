import { latestComparison } from "../btc/chart";
import { captureCandidateFromPersistedEvidence } from "./candidate-capture";
import { createWaterxBackgroundQueue } from "./background-queue";
import { captureLockObservation,loadEarlyDecision } from "./lock-store";
import { createLockTimers } from "./lock-timers";
import { captureResearchObservation } from "./research-store";
import { roundDecisions } from "./round-decision";
import {refreshHealth,refreshErrorClass} from "./refresh-health";
import {boundedDatabaseRetry} from "./bounded-retry";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
import {observationId} from "./observation-provenance";
import {observeTimedStrategy,stopTimedStrategy,startTimedRecovery,timedStrategyQueueMetrics} from "./timed-decision-coordinator";
import {timedPoolHealth} from "./timed-db";
import { getCurrentWaterxRound, getWaterxRoundAtEpoch, verifiedHistoricalRound, WaterxProviderError } from "./source";
import type { WaterxInterval, WaterxRound } from "./types";
import { listPendingWaterxSettlements, markWaterxSettlementAttempt, recordWaterxRound, recordWaterxSettlement, type WaterxRoundInput } from "./learning";
import {
  getAllWaterxDiagnostics, getWaterxDiagnostics, waterxFetchFailed, waterxFetchFinished,
  waterxFetchStarted, waterxFetchSucceeded, waterxScheduleTick, waterxScheduleNext,
  waterxWorkerHeartbeat, waterxRecoveryAttempt, waterxObservationBackgroundStarted,
  waterxObservationBackgroundFinished, waterxStorageFailed, waterxRequestSucceeded,
  waterxCandidateCaptureFinished,
} from "./diagnostics";

type WaterxSnapshot = {
  observedAt: string | null;
  receivedAtMs?:number;
  status: "LIVE" | "STALE" | "UNAVAILABLE" | "HOLD";
  round: WaterxRound | null;
  reason: string;
  sourceError: string | null;
};

const intervals: WaterxInterval[] = [5, 15];
const snapshots = new Map<WaterxInterval, WaterxSnapshot>(intervals.map(interval => [interval, {
  observedAt: null, status: "UNAVAILABLE", round: null,
  reason: "Waiting for the first WaterX public read.", sourceError: null,
}]));
const timers = new Map<WaterxInterval, NodeJS.Timeout>();
const running = new Set<WaterxInterval>();
const failures = new Map<WaterxInterval, number>();
const retryDelays = new Map<WaterxInterval, number>();
const refreshes = new Map<WaterxInterval, Promise<void>>();
const latestRoundStarts = new Map<WaterxInterval, number>();
const latestRoundIds = new Map<WaterxInterval, string>();
const REFRESH_WAIT_MS = 5_000;
const PROVIDER_READ_TIMEOUT_MS = 10_000;
const watchdogs = new Map<WaterxInterval, NodeJS.Timeout>();
const refreshControllers = new Map<WaterxInterval, AbortController>();
const settlementJobs = new Map<WaterxInterval, Promise<void>>();
const lastSettlementAttempt = new Map<WaterxInterval, number>();
const SETTLEMENT_POLL_MS = 60_000;

function validOutcome(value: string | null): "UP" | "DOWN" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "UP" || normalized === "DOWN" ? normalized : null;
}

async function reconcileKnown(interval: WaterxInterval): Promise<void> {
  const pending = await listPendingWaterxSettlements(interval, 2);
  for (const row of pending) {
    try {
      if (!Number.isSafeInteger(row.startMs) || !Number.isSafeInteger(row.expiryMs) ||
          row.startMs % 1000 !== 0 || row.expiryMs % 1000 !== 0) {
        console.warn(`[waterx-${interval}m] skipped settlement with fractional or invalid round timestamps`);
        continue;
      }
      if (!await markWaterxSettlementAttempt(interval, row.roundId)) continue;
      const closingEpoch = row.expiryMs / 1000;
      const historical = await getWaterxRoundAtEpoch(interval, closingEpoch);
      const resolved = verifiedHistoricalRound(historical, row.roundId, closingEpoch);
      const status = resolved.resolutionStatus?.trim().toLowerCase();
      if (!status) continue;
      const outcome = resolved.settlement?.outcome ?? null;
      const settledAt = resolved.settlement?.settledAt ?? null;
      if (status !== "resolved")
        continue;
      const observedAt = new Date().toISOString();
      await recordWaterxSettlement({
        intervalMinutes: interval,
        roundId: row.roundId,
        anchorPrice: resolved.anchorPrice,
        anchorConfirmed: resolved.anchorPriceConfirmed,
        settlePrice: resolved.settlePrice,
        outcome: validOutcome(outcome) ? validOutcome(outcome) : outcome,
        settledAt: settledAt === null ? null : settledAt * 1000,
        observedAt,
        resolutionStatus: status,
      });
    } catch (error) {
      // A settlement endpoint can remain unavailable while the round is not resolved.
      console.warn(`[waterx-${interval}m] settlement read failed`,
        error instanceof Error ? error.message.slice(0, 160) : "unknown error");
    }
  }
}

// Persistence and settlement must never own a live polling promise. A stalled
// database query used to strand *both* intervals after their successful first
// fetch: diagnostics had cleared fetchInFlight, while refreshes still held the
// unfinished post-fetch work and both the timer and watchdog waited on it.
type WaterxObservationInput = WaterxRoundInput & {
  probabilityDown: number | null; receivedAtMs?:number; providerSourceAtMs?:number|null;
};
const earlyLockQueue=createWaterxBackgroundQueue<WaterxObservationInput>(async input=>{
  if(input.probabilityUp===null||input.probabilityDown===null||
    !validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown)){
    try{
      const restored=await loadEarlyDecision(input);
      if(restored)roundDecisions.earlySaved(input,restored);
    }catch(error){roundDecisions.earlyFailed(input,refreshErrorClass(error));throw error;}
  }
  if(input.probabilityUp===null||input.probabilityDown===null)return;
  if(!validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown)){
    refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"EARLY_INPUT_VALIDATION",
      outcome:"error",errorClass:"INVALID_PROBABILITY_PAIR"});
    return;
  }
  refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"EARLY_INPUT_VALIDATION",outcome:"ok"});
  const started=Date.now();
  refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"EARLY_DATABASE_WRITE",outcome:"started"});
  try{
    const saved=await boundedDatabaseRetry(()=>captureLockObservation(input,{atMs:Date.parse(input.observedAt),
      receivedAtMs:input.receivedAtMs??Date.parse(input.observedAt),
      providerSourceAtMs:input.providerSourceAtMs??null,probabilityUp:input.probabilityUp!,
      probabilityDown:input.probabilityDown!,sourceHealthy:true}),{
        canRetry:()=>Date.now()<input.expiryMs&&Date.now()-(input.receivedAtMs??0)<=10_000});
    if(saved)roundDecisions.earlySaved(input,saved);
    refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"EARLY_DATABASE_WRITE",
      outcome:"ok",elapsedMs:Date.now()-started});
  }catch(error){
    roundDecisions.earlyFailed(input,refreshErrorClass(error));
    refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"EARLY_DATABASE_WRITE",
      outcome:"error",elapsedMs:Date.now()-started,errorClass:refreshErrorClass(error)});
    throw error;
  }
},(interval,error)=>console.warn(`[waterx-${interval}m] adaptive research capture failed:`,
  error instanceof Error?error.message.slice(0,180):"unknown"));
const earlyLockTimers=createLockTimers(interval=>pollWaterx(interval));
// Canonical capture is independent in BOTH runtimes. A live provider read is
// not proof of a persisted choice; legacy first-odds work must not starve it.
const canonicalLockQueue=createWaterxBackgroundQueue<WaterxObservationInput>(
  async input=>{
    const started=Date.now();
    roundDecisions.writing(input,started);
    refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"DATABASE_WRITE",outcome:"started"});
    try{
      const captureResult=await boundedDatabaseRetry(async attempt=>{
        refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"DATABASE_WRITE",
          outcome:"started",retryCount:attempt});
        return captureResearchObservation(input,{deferEnrichment:true});
      },{canRetry:()=>{
        const now=Date.now(),received=input.receivedAtMs??Date.parse(input.observedAt);
        return now<input.expiryMs&&now>=received&&now-received<=10_000;
      },onFailure:(error,attempt)=>refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,
        stage:"DATABASE_WRITE",outcome:"error",errorClass:refreshErrorClass(error),retryCount:attempt,
        elapsedMs:Date.now()-started})});
      const frozen=roundDecisions.writeFinished(input,Date.now(),captureResult);
      if(frozen!==null)refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,
        stage:"CAPTURE_RESULT",outcome:frozen?"ok":"error",errorClass:frozen?null:
          captureResult?.startsWith("Research evidence rejected:")?"CANONICAL_INPUT_REJECTED":"NO_CANONICAL_CHOICE"});
      refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"DATABASE_WRITE",
        outcome:"ok",elapsedMs:Date.now()-started});
    }catch(error){
      const errorClass=refreshErrorClass(error);
      roundDecisions.failed(input,errorClass,Date.now());
      throw error;
    }
  },
  (interval,error)=>console.warn(`[waterx-${interval}m] priority canonical capture failed:`,
    error instanceof Error?error.message.slice(0,160):"unknown"));
async function persistWaterxObservation(input: WaterxObservationInput): Promise<void> {
  waterxObservationBackgroundStarted(input.intervalMinutes);
  await recordWaterxRound(input);
  try {
    const result = await captureCandidateFromPersistedEvidence(input,{
      skipResearch:true});
    waterxCandidateCaptureFinished(input.intervalMinutes, result);
  } catch (error) {
    waterxCandidateCaptureFinished(input.intervalMinutes,
      `Candidate capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
    console.warn(`[waterx-${input.intervalMinutes}m] prospective candidate capture failed:`,
      error instanceof Error ? error.message.slice(0, 180) : "unknown error");
  }
}

const observationQueue = createWaterxBackgroundQueue<WaterxObservationInput>(
  async input => {
    const started=Date.now();
    try{
      await persistWaterxObservation(input);
      refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"OBSERVATION_DATABASE_WRITE",
        outcome:"ok",elapsedMs:Date.now()-started});
    }catch(error){
      refreshHealth.record({interval:input.intervalMinutes,roundId:input.roundId,stage:"OBSERVATION_DATABASE_WRITE",
        outcome:"error",elapsedMs:Date.now()-started,errorClass:refreshErrorClass(error)});
      throw error;
    }
    waterxObservationBackgroundFinished(input.intervalMinutes, null);
  },
  (interval, error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    waterxObservationBackgroundFinished(interval,
      message);
    waterxStorageFailed(interval, message);
    console.error(`[waterx-${interval}m] observation persistence failed:`,
      message.slice(0, 180));
  },
);

function queueSettlement(interval: WaterxInterval, now = Date.now()): void {
  if (settlementJobs.has(interval) ||
      now - (lastSettlementAttempt.get(interval) ?? -Infinity) < SETTLEMENT_POLL_MS) return;
  lastSettlementAttempt.set(interval, now);
  const job = reconcileKnown(interval)
    .catch(error => {
      console.error(`[waterx-${interval}m] settlement reconciliation failed:`,
        error instanceof Error ? error.message.slice(0, 180) : "unknown error");
    }).finally(() => {
      if (settlementJobs.get(interval) === job) settlementJobs.delete(interval);
    });
  settlementJobs.set(interval, job);
}

export function calculateWaterxRetryDelay(
  interval: WaterxInterval, error: unknown, failureCount: number, random = Math.random(),
): number {
  const rateLimited = error instanceof WaterxProviderError && error.status === 429;
  const base = rateLimited
    ? Math.max(5_000, error.retryAfterMs ?? Math.min(5 * 60_000, 5_000 * 2 ** (failureCount - 1)))
    : Math.min(60_000, (interval === 5 ? 5_000 : 10_000) * 2 ** Math.min(failureCount - 1, 3));
  // Provider rate limits are respected, while jitter prevents synchronized retries.
  const boundedRandom = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
  return Math.max(1_000, Math.round(base *
    (rateLimited ? 1 + boundedRandom * 0.2 : 0.9 + boundedRandom * 0.2)));
}

export function shouldKeepActiveRoundOnFuture(
  previous: WaterxSnapshot | undefined, candidateStartsAt: number, nowMs: number,
): boolean {
  return candidateStartsAt * 1000 > nowMs &&
    previous?.status === "LIVE" && !!previous.round &&
    previous.round.startsAt * 1000 <= nowMs && nowMs < previous.round.endsAt * 1000;
}

export function isNewerWaterxObservation(
  previous: { round?: Pick<WaterxRound, "id" | "startsAt"> | null } | undefined,
  candidate: Pick<WaterxRound, "id" | "startsAt">,
): boolean {
  if (!previous?.round) return true;
  if (candidate.startsAt < previous.round.startsAt) return false;
  return candidate.startsAt !== previous.round.startsAt || candidate.id === previous.round.id;
}

function optionalEndpoint(endpoint: string) {
  return {
    status: "separate_endpoint" as const,
    endpoint,
    reason: "Availability is reported by the linked endpoint, not inferred from the live-round read.",
  };
}

export function buildWaterxLivePayload(
  interval: WaterxInterval,
  snapshot: WaterxSnapshot,
  now: number,
  comparisonTick: ReturnType<typeof latestComparison>,
) {
  const snapshotMs = snapshot.observedAt ? Date.parse(snapshot.observedAt) : NaN;
  const stale = !Number.isFinite(snapshotMs) || now - snapshotMs > (interval === 5 ? 16_000 : 31_000);
  // A source outage does not erase already verified, still-current round identity.
  // It cannot refresh observations or make quotes executable.
  const active = snapshot.status === "LIVE" && snapshot.round &&
    snapshot.round.startsAt * 1000 <= now && now < snapshot.round.endsAt * 1000;
  const round = active && snapshot.round ? snapshot.round : null;
  const outsideRoundWindow = !stale && snapshot.status === "LIVE" && !!snapshot.round && !active;
  const comparisonTime = comparisonTick ? Date.parse(comparisonTick.asOf) : NaN;
  const comparison = comparisonTick && Number.isFinite(comparisonTime) &&
    now - comparisonTime <= 20_000 && comparisonTime <= now
    ? { price: comparisonTick.price, asOf: comparisonTick.asOf, source: comparisonTick.source } : null;
  const upSide = round?.sides.up ?? null;
  const downSide = round?.sides.down ?? null;
  const upProbability = upSide?.probabilityCents ?? null;
  const downProbability = downSide?.probabilityCents ?? null;
  const probabilitiesPresent = [upProbability, downProbability].filter(value => value !== null).length;
  const pricesPresent = [upSide, downSide].some(side =>
    side?.availability === "reported" && side.oddsCents !== null && side.oddsCents !== undefined);
  const bothSidesLocked = upSide?.availability === "locked" && downSide?.availability === "locked";
  const oddsStatus = stale ? "unavailable" : bothSidesLocked ? "locked"
    : probabilitiesPresent === 2 && upSide?.availability === "reported" && downSide?.availability === "reported"
      ? "available" : probabilitiesPresent > 0 || pricesPresent ? "partial" : "unavailable";
  const liveStatus = stale || outsideRoundWindow ? "STALE" : round ? "LIVE" : snapshot.status;
  const reason = round
    ? stale ? "Source stale; retaining recorded round identity and saved decisions, not fresh quotes." : snapshot.reason
    : stale ? "WaterX round read is stale; no active round can be certified."
      : outsideRoundWindow && snapshot.round!.startsAt * 1000 > now
        ? "WaterX round starts in the future; no active round can be certified."
        : outsideRoundWindow ? "WaterX round has expired; waiting for the next active round."
      : snapshot.reason;
  const stateForValue = (value: number | null) => value === null ? "unavailable" as const : "available" as const;
  const roundAvailability = round
    ? { status: "available" as const, reason: null }
    : { status: "unavailable" as const, reason };
  const evaluationStarted=performance.now();
  const decision=round?roundDecisions.read({intervalMinutes:interval,roundId:round.id,
    startMs:round.startsAt*1000,expiryMs:round.endsAt*1000},now):null;
  if(decision)refreshHealth.record({interval,roundId:decision.roundId,stage:"READINESS_EVALUATION",
    outcome:decision.market&&!decision.readiness.components.fresh?"error":"ok",
    errorClass:decision.market&&!decision.readiness.components.fresh?"SOURCE_STALE":null,
    elapsedMs:performance.now()-evaluationStarted,sourceAgeMs:decision.market?now-decision.market.receivedAtMs:null});
  if(decision?.componentHealth)decision.componentHealth.priceFeed=comparison?"AVAILABLE":"UNAVAILABLE";
  const referenceAvailability = round?.anchorPrice !== null && round?.anchorPrice !== undefined
    ? { status: round.anchorPriceConfirmed ? "available" as const : "provisional" as const,
      reason: round.anchorPriceConfirmed ? null : "WaterX has not confirmed the reported reference." }
    : { status: "unavailable" as const, reason: round?.referenceUnavailableReason ?? "No active WaterX reference is available." };
  const oddsReason = oddsStatus === "available" ? null
    : oddsStatus === "locked" ? "WaterX market sides are locked; no live probability pair is available."
      : oddsStatus === "partial" ? "WaterX side data is partial; probabilities or prices may be missing."
      : "Odds temporarily unavailable.";

  return {
    serverTime: new Date(now).toISOString(),
    captureQueues:{canonical:canonicalLockQueue.metrics(now),early:earlyLockQueue.metrics(now),
      timed:{...timedStrategyQueueMetrics(now),database:timedPoolHealth()},optional:observationQueue.metrics(now)},
    refreshHealth:refreshHealth.read(interval),
    decision,
    status: liveStatus,
    intervalMinutes: interval,
    round: round ? {
      id: round.id,
      marketId: round.marketId,
      marketSlug: round.slug,
      startMs: round.startsAt * 1000,
      expiryMs: round.endsAt * 1000,
      referencePrice: round.anchorPrice,
      anchorConfirmed: round.anchorPriceConfirmed,
      phase: round.phase,
      // WaterX's route epoch selects the round ending at that boundary.
      // The opening epoch links to the preceding round.
      url: providerUrl(interval, round.endsAt),
    } : null,
    odds: round ? {
      up: upProbability === null ? null : upProbability / 100,
      down: downProbability === null ? null : downProbability / 100,
      upPriceCents: upSide?.oddsCents ?? null,
      downPriceCents: downSide?.oddsCents ?? null,
      asOf: snapshot.observedAt,
      source: "WaterX public market probabilities and odds",
      sourceId:"waterx.public.crypto.v1",
      observationId:snapshot.receivedAtMs?observationId(interval,round!.id,snapshot.receivedAtMs):null,
      receivedAtMs:snapshot.receivedAtMs??null,
      interpretation:{probabilityCents:"provider-reported probability; validate explicit pair",
        oddsCents:"indicative purchase ask; not complementary probability or full-size fill"},
    } : null,
    comparison,
    availability: {
      roundMetadata: roundAvailability,
      referencePrice: referenceAvailability,
      odds: {
        status: oddsStatus,
        reason: oddsReason,
        up: {
          probability: stateForValue(upProbability),
          price: upSide?.oddsCents === null || upSide?.oddsCents === undefined ? "unavailable" as const : "reported" as const,
          pricePositive: upSide?.oddsCents !== null && upSide?.oddsCents !== undefined && upSide.oddsCents > 0,
          executable: false as const,
          side: upSide?.availability ?? "unavailable",
          reason: upSide?.reason ?? (upProbability === null ? "WaterX UP probability was not reported." : null),
        },
        down: {
          probability: stateForValue(downProbability),
          price: downSide?.oddsCents === null || downSide?.oddsCents === undefined ? "unavailable" as const : "reported" as const,
          pricePositive: downSide?.oddsCents !== null && downSide?.oddsCents !== undefined && downSide.oddsCents > 0,
          executable: false as const,
          side: downSide?.availability ?? "unavailable",
          reason: downSide?.reason ?? (downProbability === null ? "WaterX DOWN probability was not reported." : null),
        },
      },
      comparisonPrice: comparison
        ? { status: "available" as const, reason: null }
        : { status: "unavailable" as const, reason: "No fresh Coinbase comparison price is available." },
      chart: optionalEndpoint("/api/waterx/chart"),
      settlement: round ? {
        endpoint: "/api/waterx/history",
        status: round.resolutionStatus?.trim().toLowerCase() === "resolved" &&
          !!round.settlement?.outcome && round.settlement.settledAt !== null && round.settlePrice !== null
          ? "available" as const : "pending" as const,
        reason: round.resolutionStatus?.trim().toLowerCase() === "resolved"
          ? "Settlement evidence is provider-reported and is checked by the settlement history path."
          : "This round has no provider-reported resolved settlement.",
      } : {
        endpoint: "/api/waterx/history",
        status: "unavailable" as const,
        reason: "No certified active round is available for settlement status.",
      },
      model: optionalEndpoint("/api/waterx/model"),
    },
    execution: { action: "HOLD" as const, reason: "Read-only data source; no recommendation or order is generated." },
    reason,
  };
}

async function collectWaterx(interval: WaterxInterval, signal: AbortSignal): Promise<void> {
  const requestedAt=Date.now();
  refreshHealth.record({interval,stage:"PROVIDER_REQUEST",outcome:"started",retryCount:failures.get(interval)??0});
  const result = await getCurrentWaterxRound(interval, undefined, {
    signal, timeoutMs: PROVIDER_READ_TIMEOUT_MS,
    onRequestReceived: at => {
      if(signal.aborted)return;
      waterxRequestSucceeded(interval, at);
      refreshHealth.record({interval,stage:"PROVIDER_RESPONSE",outcome:"ok",elapsedMs:Date.parse(at)-requestedAt});
    },
  });
  // An aborted operation is no longer allowed to change snapshots, diagnostics,
  // or enqueue persistence, even if a non-compliant transport resolves late.
  if (signal.aborted) return;
  failures.delete(interval);
  retryDelays.delete(interval);
  const now = Date.now();
  const observedAt = new Date().toISOString();
  const candidate = result.detail.round;
  refreshHealth.record({interval,roundId:candidate.id,stage:"PARSE_VALIDATION",outcome:"ok",elapsedMs:Date.now()-requestedAt});
  const previous = snapshots.get(interval);
  const latestStart = latestRoundStarts.get(interval);
  const previousIdentity = latestStart === undefined ? previous : {
    round: {
      startsAt: latestStart,
      id: latestRoundIds.get(interval) ?? previous?.round?.id ?? candidate.id,
    },
  };
  if (!isNewerWaterxObservation(previousIdentity, candidate)) {
    refreshHealth.record({interval,roundId:candidate.id,stage:"IDENTITY_VALIDATION",outcome:"error",errorClass:"ROUND_REGRESSION"});
    waterxFetchSucceeded(interval, candidate, now, false, undefined,
      result.sourceTimestamp, result.requestReceivedAt);
    queueSettlement(interval, now);
    return;
  }
  // A provider preview of the next round is not evidence that the active,
  // previously verified round has ended. Keep the latter until its expiry.
  if (result.status !== "LIVE" && shouldKeepActiveRoundOnFuture(previous, candidate.startsAt, now)) {
    waterxFetchSucceeded(interval, previous!.round!, now, true, "LIVE",
      result.sourceTimestamp, result.requestReceivedAt);
    queueSettlement(interval, now);
    return;
  }
  const startMs = candidate.startsAt * 1000;
  const expiryMs = candidate.endsAt * 1000;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(expiryMs)) {
    throw new WaterxProviderError(
      "WaterX round timestamps cannot be represented as integer milliseconds", null, null, "round_validation");
  }
  const collectorStatus = result.status === "LIVE" ? "LIVE"
    : result.status === "STALE" ? "STALE" : "NO_ACTIVE_MARKET";
  waterxFetchSucceeded(interval, candidate, now, true, collectorStatus,
    result.sourceTimestamp, result.requestReceivedAt);
  if (result.status === "LIVE") {
    latestRoundStarts.set(interval, candidate.startsAt);
    latestRoundIds.set(interval, candidate.id);
  }
  let snapshot: WaterxSnapshot;
  if (result.status === "LIVE") {
    const round = result.detail.round;
    const probabilityUp = round.sides.up.probabilityCents;
    snapshot = {
      observedAt,receivedAtMs:Date.parse(result.requestReceivedAt), status: "LIVE", round,
      reason: round.anchorPrice === null
        ? round.referenceUnavailableReason ?? "Active WaterX round; reference price unavailable."
        : round.anchorPriceConfirmed
        ? "Verified active WaterX round; anchor is provider-reported."
        : "Active WaterX round; provider-reported price-to-beat is UNCONFIRMED.",
      sourceError: null,
    };
    const input:WaterxObservationInput={
      intervalMinutes: interval, roundId: round.id, startMs, expiryMs,
      anchorPrice: round.anchorPrice, anchorConfirmed: round.anchorPriceConfirmed,
      probabilityUp: probabilityUp === null ? null : probabilityUp / 100,
      probabilityDown: round.sides.down.probabilityCents === null
        ? null : round.sides.down.probabilityCents / 100,
      observedAt, source: "WaterX",receivedAtMs:Date.parse(result.requestReceivedAt),
      // Provider header timing is not a timestamp for the individual market-odds tick.
      // Do not substitute it into odds provenance.
      providerSourceAtMs:null,
    };
    refreshHealth.record({interval,roundId:round.id,stage:"IDENTITY_VALIDATION",outcome:"ok"});
    roundDecisions.discovered(input,Date.parse(observedAt));
    const receivedAtMs=input.receivedAtMs!;
    const purchase=(side:WaterxRound["sides"]["up"])=>({
      status:side.availability,askCents:side.oddsCents,
      marketObjectId:side.trade?.marketId??null,selection:side.trade?.selection??null});
    roundDecisions.context(input,{sourceId:"waterx.public.crypto.v1",
      observationId:observationId(interval,round.id,receivedAtMs),receivedAtMs,
      providerEventAtMs:null,priceLastChangedAtMs:null,
      reference:{price:round.anchorPrice,status:round.anchorPrice===null?"unavailable":
        round.anchorPriceConfirmed?"confirmed":"provisional"},
      marketId:round.marketId,url:`https://waterx.app/en/predict/market/crypto/${round.slug}/${round.endsAt}`,
      orderCutoffAtMs:null,probabilityEvidence:input.probabilityUp===null||input.probabilityDown===null?
        "unavailable":validWaterxProbabilityPair(input.probabilityUp,input.probabilityDown)?"available":"invalid",
      purchase:{up:purchase(round.sides.up),down:purchase(round.sides.down)}});
    // Publish live progress independently of slow storage and historical reports.
    const evaluatedAt=performance.now();
    if(input.probabilityUp!==null&&input.probabilityDown!==null)roundDecisions.observe(input,{
      atMs:Date.parse(input.observedAt),receivedAtMs:input.receivedAtMs??Date.parse(input.observedAt),
      providerSourceAtMs:null,probabilityUp:input.probabilityUp,probabilityDown:input.probabilityDown,
      sourceHealthy:true});
    refreshHealth.record({interval,roundId:round.id,stage:"READINESS_INPUT",outcome:"ok",
      elapsedMs:performance.now()-evaluatedAt,sourceAgeMs:Date.now()-input.receivedAtMs!});
    earlyLockTimers.arm({intervalMinutes:interval,roundId:round.id,startMs,expiryMs});
    const comparison=latestComparison();
    observeTimedStrategy({...input,features:{referenceQuality:round.anchorPriceConfirmed?"confirmed":"provisional",
      purchaseUp:{status:round.sides.up.availability,askCents:round.sides.up.oddsCents},
      purchaseDown:{status:round.sides.down.availability,askCents:round.sides.down.oddsCents},
      comparison:comparison?{price:comparison.price,source:comparison.source,asOf:comparison.asOf}:null,
      executableQuote:null,settlementRule:"UNVERIFIED_COMPARISON_IS_NOT_SETTLEMENT",
      marketId:round.marketId,providerUrl:providerUrl(interval,round.endsAt)}});
    roundDecisions.queued(input,Date.now());
    canonicalLockQueue.enqueue(input);
    const queued=canonicalLockQueue.metrics();
    refreshHealth.record({interval,roundId:round.id,stage:"DATABASE_QUEUE",outcome:"ok",
      queueDepth:queued.depth,queueAgeMs:queued.oldestActiveAgeMs});
    // Early readiness remains research/shadow, never an execution trigger.
    earlyLockQueue.enqueue(input);
    observationQueue.enqueue(input);
  } else {
    snapshot = {
      observedAt,
      status: result.status === "STALE" ? "STALE" : "HOLD",
      round: null,
      reason: result.status === "STALE"
        ? "WaterX returned an expired round; waiting for the current interval."
        : result.detail.round.startsAt * 1000 > now
          ? "WaterX returned a future round; no active round is certified."
          : "WaterX round phase is not active; no active round is certified.",
      sourceError: null,
    };
  }
  snapshots.set(interval, snapshot);
  queueSettlement(interval, now);
}

function recordPollFailure(interval: WaterxInterval, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  if (error instanceof WaterxProviderError && error.requestReceivedAt)
    waterxRequestSucceeded(interval, error.requestReceivedAt);
  const failureCount = Math.min((failures.get(interval) ?? 0) + 1, 8);
  failures.set(interval, failureCount);
  const delay = calculateWaterxRetryDelay(interval, error, failureCount);
  retryDelays.set(interval, delay);
  const stage = error instanceof WaterxProviderError ? error.stage
    : /invalid|malformed|mismatch|cadence|unknown waterx|incomplete/i.test(message)
      ? "parse" : "provider";
  const invalidResponse = stage === "parse" || stage === "round_validation";
  refreshHealth.record({interval,stage:stage==="parse"?"PARSE_VALIDATION":
    stage==="round_validation"?"IDENTITY_VALIDATION":"PROVIDER_RESPONSE",outcome:"error",
    errorClass:refreshErrorClass(error),retryCount:failureCount});
  waterxFetchFailed(interval, message, delay, Date.now(),
    invalidResponse ? "INVALID_RESPONSE" : "DISCONNECTED", stage);
  const previous=snapshots.get(interval),at=Date.now();
  // Keep known same-round data during a transient read failure; never refresh its observation clock.
  if(!invalidResponse&&previous?.round&&previous.status==="LIVE"&&
    previous.round.startsAt*1000<=at&&at<previous.round.endsAt*1000){
    snapshots.set(interval,{...previous,reason:"Provider refresh failed; last same-round observation retained while retrying.",
      sourceError:refreshErrorClass(error)});
    return;
  }
  snapshots.set(interval, {
    observedAt: new Date().toISOString(), status: "UNAVAILABLE", round: null,
    reason: message.includes("429") ? "WaterX rate limited the public read; retrying independently."
      : `WaterX public read unavailable: ${message.slice(0, 180)}`,
    sourceError: message.slice(0, 180),
  });
}

type WaterxPoll = (interval: WaterxInterval, signal: AbortSignal) => Promise<void>;

/** Coalesce reads; abort and release a timed-out owner before allowing a retry. */
function pollWaterx(
  interval: WaterxInterval,
  poll: WaterxPoll = collectWaterx,
  timeoutMs = PROVIDER_READ_TIMEOUT_MS,
  trackDiagnostics = true,
): Promise<void> {
  const existing = refreshes.get(interval);
  if (existing) return existing;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  if (trackDiagnostics) waterxFetchStarted(interval);
  refreshControllers.set(interval, controller);
  const operation = Promise.resolve().then(() => poll(interval, controller.signal));
  const cancelled = new Promise<void>(resolve => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  timeout = setTimeout(() => {
    timedOut = true;
    recordPollFailure(interval,
      new WaterxProviderError(`WaterX provider read exceeded ${timeoutMs}ms`, null, null, "timeout"));
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();
  const refresh = Promise.race([operation, cancelled])
    .then(() => {
      if (!timedOut) {
        failures.delete(interval);
        retryDelays.delete(interval);
      }
    }, error => {
      if (refreshControllers.get(interval) === controller && !controller.signal.aborted)
        recordPollFailure(interval, error);
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort();
      if (refreshControllers.get(interval) === controller) {
        if (trackDiagnostics) waterxFetchFinished(interval);
        refreshControllers.delete(interval);
      }
      if (refreshes.get(interval) === refresh) refreshes.delete(interval);
    });
  refreshes.set(interval, refresh);
  return refresh;
}

/** Recover a timer that stopped scheduling without starting a second read. */
export function shouldWatchdogPollWaterx(
  lastAttemptAt: string | null, inFlight: boolean, now: number, periodMs: number,
  retryAt: string | null = null,
): boolean {
  if (inFlight || !Number.isFinite(now) || !Number.isFinite(periodMs) || periodMs <= 0) return false;
  if (retryAt && Date.parse(retryAt) > now) return false;
  const attempted = lastAttemptAt ? Date.parse(lastAttemptAt) : NaN;
  return !Number.isFinite(attempted) || now - attempted > Math.max(25_000, periodMs * 3);
}

/** Start independent, read-only collectors for both WaterX round durations. */
export function startWaterxCapture(options: {
  poll?: WaterxPoll;
  periods?: Partial<Record<WaterxInterval, number>>;
  watchdogPeriodMs?: number;
  readTimeoutMs?: number;
  retryDelayMs?: number;
  onStalled?: (interval: WaterxInterval, ageMs: number) => void;
} = {}): () => void {
  startTimedRecovery();
  const notifiedStalls = new Set<WaterxInterval>();
  for (const interval of intervals) {
    if (running.has(interval)) continue;
    running.add(interval);
    const periodMs = options.periods?.[interval] ?? 5_000;
    const tick = () => {
      timers.delete(interval);
      waterxScheduleTick(interval);
      void pollWaterx(interval, options.poll ?? collectWaterx, options.readTimeoutMs, !options.poll)
        .catch(error => {
          console.error(`[waterx-${interval}m] unexpected collector failure:`,
            error instanceof Error ? error.message.slice(0, 180) : "unknown error");
        }).finally(() => {
          if (!running.has(interval) || timers.has(interval)) return;
          const round=snapshots.get(interval)?.round;
          const inEarlyWindow=round&&
            round.endsAt*1000-Date.now()<=(interval===5?120_000:360_000);
          const nextAt = Date.now() + (options.retryDelayMs ?? retryDelays.get(interval) ??
            (inEarlyWindow?Math.min(periodMs,3000):periodMs));
          const timer = setTimeout(tick, nextAt - Date.now());
          timer.unref?.();
          timers.set(interval, timer);
          waterxScheduleNext(interval, nextAt);
        });
    };
    tick();
    // This clock is independent of the recursive poll timer. Aborting a
    // timed-out read releases the interval owner before any retry can start.
    const watchdog = setInterval(() => {
      waterxWorkerHeartbeat(interval);
      if (!running.has(interval)) return;
      const health = getWaterxDiagnostics(interval);
      if (health.fetchInFlightAgeMs !== null && health.fetchInFlightAgeMs > 60_000) {
        if (!notifiedStalls.has(interval)) {
          notifiedStalls.add(interval);
          console.error(`[waterx-${interval}m] collector read exceeded 60 seconds; ` +
            "do not report LIVE until a fresh provider observation is received.");
          options.onStalled?.(interval, health.fetchInFlightAgeMs);
        }
        return;
      }
      if (refreshes.has(interval)) return;
      notifiedStalls.delete(interval);
      if (shouldWatchdogPollWaterx(health.lastFetchAttemptAt, health.fetchInFlight,
        Date.now(), periodMs, health.retryAt)) {
        waterxRecoveryAttempt(interval);
        const scheduled = timers.get(interval);
        if (scheduled) clearTimeout(scheduled);
        timers.delete(interval);
        tick();
      }
    }, options.watchdogPeriodMs ?? 15_000);
    watchdog.unref?.();
    watchdogs.set(interval, watchdog);
  }
  return () => {
    earlyLockTimers.stop();
    stopTimedStrategy();
    for (const timer of Array.from(timers.values())) clearTimeout(timer);
    for (const controller of Array.from(refreshControllers.values())) controller.abort();
    for (const watchdog of Array.from(watchdogs.values())) clearInterval(watchdog);
    watchdogs.clear();
    timers.clear();
    running.clear();
  };
}

function providerUrl(interval: WaterxInterval, closingSeconds: number): string {
  return `https://waterx.app/en/predict/market/crypto/crypto-btc-updown-${interval}m/${closingSeconds}`;
}

export function waterxLive(interval: WaterxInterval) {
  assertInterval(interval);
  const now = Date.now();
  const payload=buildWaterxLivePayload(interval, snapshots.get(interval)!, now, latestComparison());
  refreshHealth.record({interval,roundId:payload.round?.id,stage:"PUBLICATION",outcome:"ok",
    sourceAgeMs:payload.decision?.market?now-payload.decision.market.receivedAtMs:null});
  return payload;
}

function snapshotNeedsRefresh(interval: WaterxInterval): boolean {
  if (refreshes.has(interval)) return true;
  const snapshot = snapshots.get(interval)!;
  const observedMs = snapshot.observedAt ? Date.parse(snapshot.observedAt) : NaN;
  const now = Date.now();
  const maxAgeMs = interval === 5 ? 16_000 : 31_000;
  const lastAttempt = getWaterxDiagnostics(interval).lastFetchAttemptAt;
  // During a round transition, a freshly received but expired provider round
  // should not block another read until the ordinary snapshot-age threshold.
  if (lastAttempt && now - Date.parse(lastAttempt) < 1_500) return false;
  return snapshot.status !== "LIVE" || !Number.isFinite(observedMs) ||
    now - observedMs > maxAgeMs ||
    !!snapshot.round && now >= snapshot.round.endsAt * 1000;
}

/** Return the local snapshot, refreshing stale data once per interval with a bounded wait. */
export async function getLiveWaterx(interval: WaterxInterval) {
  assertInterval(interval);
  const retryAt = getWaterxDiagnostics(interval).retryAt;
  const retryPending = retryAt !== null && Date.parse(retryAt) > Date.now();
  if (snapshotNeedsRefresh(interval) && !retryPending) {
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      pollWaterx(interval),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, REFRESH_WAIT_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
  return waterxLive(interval);
}

export { getWaterxDiagnostics, getAllWaterxDiagnostics };

function assertInterval(interval: number): asserts interval is WaterxInterval {
  if (interval !== 5 && interval !== 15)
    throw new Error("WaterX interval must be 5 or 15 minutes");
}
